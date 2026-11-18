import ForceGraph3D, {ForceGraph3DInstance} from '3d-force-graph';
import * as THREE from 'three';
import {ConvexGeometry} from 'three/examples/jsm/geometries/ConvexGeometry.js';
import {UnrealBloomPass} from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/examples/jsm/postprocessing/OutputPass.js';
import {colorForNode, tagColor} from './Colors.js';
import {el} from './Dom.js';
import type {EventKind} from './Events.js';
import type {GraphRenderer, GraphRendererCallbacks, GraphRendererState} from './GraphRenderer.js';
import {CONCENTRATE_COLOR, filterGraph, PULSE_COLORS, concentrateOpacity, concentrateRadius} from './GraphRenderer.js';
import {PersistentValue} from './Persistence.js';
import {trailOpacity} from './Trail.js';

const STORAGE_POSITIONS_3D = 'synaipse.graph3d.positions';
type Position3DMap = Record<string, {x: number; y: number; z: number}>;
// Debounce persistence: drag-end can fire rapidly during pan-drag, and a
// 3500-node vault is non-trivial to JSON.stringify.
const positionsStore3D = new PersistentValue<Position3DMap>(STORAGE_POSITIONS_3D, {}, undefined, 500);

/**
 * How many force-simulation ticks the engine is allowed to run after a
 * (re)build. The library default is Infinity, capped by a 15s wall-clock
 * timer — which on a multi-thousand-node vault burns CPU for the full
 * 15s because every tick is O(N log N). With saved positions restored as
 * seeds, ~80 ticks is enough to settle visible drift without staying
 * busy for seconds at a time.
 */
const COOLDOWN_TICKS = 80;

interface NodeRecord {
    id: string;
    title: string;
    tags: string[];
    color: string;
    radius: number;
    x?: number;
    y?: number;
    z?: number;
    sphere?: THREE.Mesh<THREE.SphereGeometry, THREE.MeshLambertMaterial>;
    baseColor?: THREE.Color;
    pulseUntil?: number;
    pulseColor?: THREE.Color;
    // Instance slot in the lean-mode InstancedMesh (== index in `nodes`).
    index?: number;
}

interface Trail3DRecord {
    line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    fromId: string;
    toId: string;
    startedAt: number;
}

const TRAIL_DURATION_MS = 2200;
const WAVE_DURATION_MS = 1100;
const WAVE_END_SCALE_FACTOR = 7;
const WAVE_SECONDARY_DELAY_MS = 220;
const FOCUS_DURATION_MS = 650;
const FOCUS_DISTANCE = 90;
const ORBIT_SPEED_RAD_PER_FRAME = 0.0018;
const ORBIT_START_DELAY_MS = 150;
const BLOOM_STRENGTH = 0.45;
const BLOOM_RADIUS = 0.4;
const BLOOM_THRESHOLD = 0.55;
const PARTICLE_COUNT = 2;
const PARTICLE_SPEED = 0.0045;
const PARTICLE_WIDTH = 1.1;
const PARTICLE_COLOR = '#ffd166';
const LINK_COLOR_NORMAL = 'rgba(150, 160, 180, 0.45)';
const LINK_COLOR_HIGHLIGHT = 'rgba(255, 209, 102, 0.9)';
const LINK_COLOR_DIM = 'rgba(150, 160, 180, 0.08)';
const NODE_OPACITY_NORMAL = 0.95;
const NODE_OPACITY_DIM = 0.16;
const HULL_FILL_OPACITY = 0.07;
const HULL_EDGE_OPACITY = 0.5;
const HULL_LABEL_SCALE = 22;
const HULL_MIN_POINTS = 4;
const ROOM_GRID_SIZE = 800;
const ROOM_GRID_DIVISIONS = 8;
const ROOM_GRID_COLOR = 0x3a4358;
const ROOM_GRID_OPACITY = 0.32;
const CLUSTER_ANCHOR_RADIUS = 220;
const CLUSTER_STRENGTH = 0.18;

// Above this visible-node count the per-frame cost of the full-fat look
// (fullscreen UnrealBloom, link particles, high-poly *transparent* spheres)
// collapses the frame rate to ~6 FPS on a multi-thousand-node vault — the
// transparent flag alone forces three.js to depth-sort every sphere each
// frame and disables z-culling. Above the threshold we switch to a lean
// path: opaque low-poly spheres, no bloom, no particles. Below it the graph
// is small enough that the rich look stays smooth.
const HEAVY_EFFECTS_MAX_NODES = 1200;
const SPHERE_SEGMENTS_RICH = 18;
const SPHERE_SEGMENTS_LEAN = 8;

interface SimNode {
    id: string;
    tags: string[];
    x?: number;
    y?: number;
    z?: number;
    vx: number;
    vy: number;
    vz: number;
}

interface LinkRecord {
    source: string;
    target: string;
}

interface Wave3DRecord {
    mesh: THREE.LineSegments<THREE.WireframeGeometry, THREE.LineBasicMaterial>;
    nodeId: string;
    startRadius: number;
    endRadius: number;
    startedAt: number;
}

const PULSE_DURATION_MS = 1400;

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

export class GraphView3D implements GraphRenderer {
    public readonly element: HTMLElement;
    private state: GraphRendererState;
    private canvas: HTMLElement;
    private stats: HTMLElement;
    private graph: ForceGraph3DInstance | null = null;
    private nodes: NodeRecord[] = [];
    // Kept in sync with `nodes` inside rebuild(). Hot-path lookups
    // (click/hover/focus/trail/wave) went through .find() before, which
    // was O(N) per event — noticeable above a few thousand nodes.
    private nodeById: Map<string, NodeRecord> = new Map();
    private links: LinkRecord[] = [];
    private animating = false;
    private rafHandle: number | null = null;
    private trailRaf: number | null = null;
    private trails: Trail3DRecord[] = [];
    private waveRaf: number | null = null;
    private waves: Wave3DRecord[] = [];
    private resizeObserver: ResizeObserver | null = null;
    private orbitTargetId: string | null = null;
    private orbitAngle = 0;
    private orbitRadius = FOCUS_DISTANCE;
    private orbitHeight = 0;
    private orbitRaf: number | null = null;
    private orbitStartTimer: number | null = null;
    private pointerDownHandler: ((ev: PointerEvent) => void) | null = null;
    private pointerMoveHandler: ((ev: PointerEvent) => void) | null = null;
    private pointerUpHandler: ((ev: PointerEvent) => void) | null = null;
    private pointerDownPos: {x: number; y: number} | null = null;
    private hoverNodeId: string | null = null;
    private adjacency = new Map<string, Set<string>>();
    private hullGroup: THREE.Group | null = null;
    private hullsDirty = false;
    private roomGridGroup: THREE.Group | null = null;
    private clusterForceAttached = false;
    private tagAnchors = new Map<string, {x: number; y: number; z: number}>();
    // Set once on first build from the node count; gates bloom/particles and
    // the low-poly sphere path. See HEAVY_EFFECTS_MAX_NODES.
    private lightweight = false;
    // Sphere geometry is identical for every node of the same radius, so we
    // share one instance per (radius, segments) instead of allocating a fresh
    // ~650-triangle geometry per node — 2646 allocations became a handful.
    private sphereGeoCache = new Map<string, THREE.SphereGeometry>();

    // ---- Lean-mode instanced node rendering -------------------------------
    // In lean mode all node spheres collapse into a single InstancedMesh (one
    // draw call for the whole graph instead of one per node). The library's
    // built-in per-node meshes are what it raycasts for hover/click, so with
    // them gone we do our own picking (pickNodeAt) and tooltip.
    private instanced: THREE.InstancedMesh | null = null;
    private instanceGeom: THREE.SphereGeometry | null = null;
    private instanceMat: THREE.MeshLambertMaterial | null = null;
    // All links share one LineSegments buffer in lean mode. The library draws
    // every link as its own THREE.Line (one draw call each — 5000+ on a big
    // vault); batching them collapses that to a single draw call.
    private linkLines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
    private linkPositions: Float32Array | null = null;
    private instancesDirty = false;
    private syncRaf: number | null = null;
    private highlightSet: Set<string> | null = null;
    private heatById: ReadonlyMap<string, number> | null = null;
    private tooltip: HTMLElement | null = null;
    private raycaster = new THREE.Raycaster();
    private readonly hotColor = new THREE.Color('#ffd166');
    private readonly identityQuat = new THREE.Quaternion();
    private readonly tmpMatrix = new THREE.Matrix4();
    private readonly tmpColor = new THREE.Color();
    private readonly tmpPos = new THREE.Vector3();
    private readonly tmpScale = new THREE.Vector3();
    private readonly tmpNdc = new THREE.Vector2();

    public constructor(initial: GraphRendererState, private readonly cb: GraphRendererCallbacks) {
        this.state = initial;
        this.element = el('div', {class: 'graph-canvas graph-canvas-3d'});
        this.stats = el('div', {class: 'graph-stats'});
        this.canvas = el('div', {class: 'graph'});
        this.element.appendChild(this.stats);
        this.element.appendChild(this.canvas);
    }

    public mount(): void {
        this.rebuild();

        const observer = new ResizeObserver(() => {
            if (this.graph !== null) {
                this.graph.width(this.canvas.clientWidth);
                this.graph.height(this.canvas.clientHeight);
            }
        });
        observer.observe(this.canvas);
        this.resizeObserver = observer;

        const DRAG_THRESHOLD_PX = 5;

        this.pointerDownHandler = (ev) => {
            this.pointerDownPos = {x: ev.clientX, y: ev.clientY};
        };
        this.pointerMoveHandler = (ev) => {
            if (this.pointerDownPos !== null) {
                const dx = ev.clientX - this.pointerDownPos.x;
                const dy = ev.clientY - this.pointerDownPos.y;

                if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
                    this.stopOrbit();
                    this.pointerDownPos = null;
                }
            }

            // Lean mode owns its own hover picking (the library has no per-node
            // mesh to raycast). Skip while a drag is in progress.
            if (this.instanced !== null && this.pointerDownPos === null) {
                const picked = this.pickNodeAt(ev);
                const id = picked === null ? null : picked.id;

                if (id !== this.hoverNodeId) {
                    this.hoverNodeId = id;
                    this.applyHoverHighlight();
                }

                this.updateTooltip(picked, ev);
            }
        };
        this.pointerUpHandler = (ev) => {
            // A pointerup that never crossed the drag threshold (pointerDownPos
            // still set) is a click — pick the node under it and open it.
            const wasClick = this.pointerDownPos !== null;
            this.pointerDownPos = null;

            if (wasClick && this.instanced !== null) {
                const picked = this.pickNodeAt(ev);

                if (picked !== null) {
                    this.focusOnNode(picked);
                    this.focus(picked.id);
                    window.setTimeout(() => this.cb.onSelectNote(picked.id), FOCUS_DURATION_MS);
                }
            }
        };

        this.canvas.addEventListener('pointerdown', this.pointerDownHandler);
        this.canvas.addEventListener('pointermove', this.pointerMoveHandler);
        this.canvas.addEventListener('pointerup', this.pointerUpHandler);
    }

    public update(state: GraphRendererState): void {
        const prev = this.state;
        this.state = state;

        const needsRebuild =
            state.data !== prev.data
            || state.selectedTags !== prev.selectedTags
            || state.hideIsolated !== prev.hideIsolated;

        if (needsRebuild) {
            this.rebuild();
        }

        if (state.showHulls !== prev.showHulls || needsRebuild) {
            this.hullsDirty = true;
            this.refreshHulls();
        }

        if (state.showRoomGrid !== prev.showRoomGrid) {
            this.refreshRoomGrid();
        }

        if (state.showCluster !== prev.showCluster || needsRebuild) {
            this.refreshClusterForce();
        }
    }

    public destroy(): void {
        if (this.rafHandle !== null) {
            cancelAnimationFrame(this.rafHandle);
            this.rafHandle = null;
        }
        if (this.trailRaf !== null) {
            cancelAnimationFrame(this.trailRaf);
            this.trailRaf = null;
        }
        for (const trail of this.trails) {
            trail.line.parent?.remove(trail.line);
            trail.line.geometry.dispose();
            trail.line.material.dispose();
        }
        this.trails = [];
        if (this.waveRaf !== null) {
            cancelAnimationFrame(this.waveRaf);
            this.waveRaf = null;
        }
        for (const wave of this.waves) {
            wave.mesh.parent?.remove(wave.mesh);
            wave.mesh.geometry.dispose();
            wave.mesh.material.dispose();
        }
        this.waves = [];
        this.stopOrbit();

        if (this.pointerDownHandler !== null) {
            this.canvas.removeEventListener('pointerdown', this.pointerDownHandler);
            this.pointerDownHandler = null;
        }

        if (this.pointerMoveHandler !== null) {
            this.canvas.removeEventListener('pointermove', this.pointerMoveHandler);
            this.pointerMoveHandler = null;
        }

        if (this.pointerUpHandler !== null) {
            this.canvas.removeEventListener('pointerup', this.pointerUpHandler);
            this.pointerUpHandler = null;
        }

        this.pointerDownPos = null;

        this.disposeHulls();
        this.disposeRoomGrid();
        this.disposeInstances();

        if (this.tooltip !== null) {
            this.tooltip.remove();
            this.tooltip = null;
        }

        this.resizeObserver?.disconnect();
        this.resizeObserver = null;

        if (this.graph !== null) {
            this.graph._destructor();
            this.graph = null;
        }

        for (const geom of this.sphereGeoCache.values()) {
            geom.dispose();
        }
        this.sphereGeoCache.clear();
    }

    public applyHeat(heatById: ReadonlyMap<string, number>): void {
        if (this.instanced !== null) {
            // Lean mode: heat is folded into the per-instance color/scale pass.
            this.heatById = heatById;
            this.markInstancesDirty();
            return;
        }

        for (const node of this.nodes) {
            if (node.sphere === undefined || node.baseColor === undefined) {
                continue;
            }

            if (node.pulseUntil !== undefined) {
                continue;
            }

            const raw = heatById.get(node.id) ?? 0;
            const heat = Math.min(1, Math.max(0, raw / 5));

            if (!this.state.showHeat || heat <= 0) {
                node.sphere.material.emissive.copy(node.baseColor).multiplyScalar(0.25);
                node.sphere.scale.setScalar(1);
                continue;
            }

            const hot = new THREE.Color('#ffd166');
            node.sphere.material.emissive
                .copy(node.baseColor)
                .lerp(hot, 0.3 + heat * 0.5)
                .multiplyScalar(0.4 + heat * 0.6);
            node.sphere.scale.setScalar(1 + heat * 0.4);
        }
    }

    public trail(fromId: string, toId: string, kind: EventKind): void {
        if (this.graph === null || fromId === toId) {
            return;
        }

        const from = this.nodeById.get(fromId);
        const to = this.nodeById.get(toId);

        if (from === undefined || to === undefined) {
            return;
        }

        if (from.x === undefined || to.x === undefined) {
            return;
        }

        const colorHex = PULSE_COLORS[kind];
        const material = new THREE.LineBasicMaterial({
            color: new THREE.Color(colorHex),
            transparent: true,
            opacity: 0.95,
            linewidth: 2
        });

        const points = [
            new THREE.Vector3(from.x ?? 0, from.y ?? 0, from.z ?? 0),
            new THREE.Vector3(to.x ?? 0, to.y ?? 0, to.z ?? 0)
        ];
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geometry, material);

        const scene = this.graph.scene();
        scene.add(line);

        this.trails.push({line, fromId, toId, startedAt: performance.now()});
        this.scheduleTrailTick();
    }

    private scheduleTrailTick(): void {
        if (this.trailRaf !== null) {
            return;
        }

        const tick = (): void => {
            const now = performance.now();
            const survivors: Trail3DRecord[] = [];

            for (const trail of this.trails) {
                const elapsed = now - trail.startedAt;
                const opacity = trailOpacity(elapsed, TRAIL_DURATION_MS);

                if (opacity <= 0) {
                    trail.line.parent?.remove(trail.line);
                    trail.line.geometry.dispose();
                    trail.line.material.dispose();
                    continue;
                }

                trail.line.material.opacity = opacity;

                const from = this.nodeById.get(trail.fromId);
                const to = this.nodeById.get(trail.toId);

                if (from !== undefined && to !== undefined && from.x !== undefined && to.x !== undefined) {
                    const positions = trail.line.geometry.getAttribute('position') as THREE.BufferAttribute;
                    positions.setXYZ(0, from.x ?? 0, from.y ?? 0, from.z ?? 0);
                    positions.setXYZ(1, to.x ?? 0, to.y ?? 0, to.z ?? 0);
                    positions.needsUpdate = true;
                }

                survivors.push(trail);
            }

            this.trails = survivors;

            if (this.trails.length === 0) {
                this.trailRaf = null;
                return;
            }

            this.trailRaf = requestAnimationFrame(tick);
        };

        this.trailRaf = requestAnimationFrame(tick);
    }

    public pulse(noteIds: readonly string[], kind: EventKind): void {
        const color = new THREE.Color(PULSE_COLORS[kind]);
        const expiresAt = Date.now() + PULSE_DURATION_MS;
        let any = false;

        for (const id of noteIds) {
            const node = this.nodeById.get(id);

            // Rich mode animates node.sphere; lean mode animates the instance.
            if (node === undefined || (this.instanced === null && node.sphere === undefined)) {
                continue;
            }

            node.pulseUntil = expiresAt;
            node.pulseColor = color;
            any = true;
        }

        if (any) {
            if (this.instanced !== null) {
                this.markInstancesDirty();
            } else {
                this.startAnimating();
            }
        }
    }

    public concentrate(noteId: string): void {
        if (this.graph === null) {
            return;
        }

        const node = this.nodeById.get(noteId);

        if (node === undefined) {
            return;
        }

        this.spawnWave3D(node, 0);
        this.spawnWave3D(node, WAVE_SECONDARY_DELAY_MS);
        this.scheduleWave3DTick();
    }

    private spawnWave3D(node: NodeRecord, delayMs: number): void {
        if (this.graph === null) {
            return;
        }

        const startRadius = node.radius * 1.2;
        const endRadius = node.radius * WAVE_END_SCALE_FACTOR;

        const sphere = new THREE.SphereGeometry(1, 16, 12);
        const wireframe = new THREE.WireframeGeometry(sphere);
        sphere.dispose();
        const material = new THREE.LineBasicMaterial({
            color: new THREE.Color(CONCENTRATE_COLOR),
            transparent: true,
            opacity: 0,
            depthWrite: false
        });
        const mesh = new THREE.LineSegments(wireframe, material);
        mesh.scale.setScalar(startRadius);

        if (node.x !== undefined && node.y !== undefined && node.z !== undefined) {
            mesh.position.set(node.x, node.y, node.z);
        }

        const scene = this.graph.scene();
        scene.add(mesh);

        this.waves.push({
            mesh,
            nodeId: node.id,
            startRadius,
            endRadius,
            startedAt: performance.now() + delayMs
        });
    }

    private scheduleWave3DTick(): void {
        if (this.waveRaf !== null) {
            return;
        }

        const tick = (): void => {
            const now = performance.now();
            const survivors: Wave3DRecord[] = [];

            for (const wave of this.waves) {
                const elapsed = now - wave.startedAt;

                if (elapsed < 0) {
                    survivors.push(wave);
                    continue;
                }

                if (elapsed >= WAVE_DURATION_MS) {
                    wave.mesh.parent?.remove(wave.mesh);
                    wave.mesh.geometry.dispose();
                    wave.mesh.material.dispose();
                    continue;
                }

                const radius = concentrateRadius(elapsed, WAVE_DURATION_MS, wave.startRadius, wave.endRadius);
                const opacity = concentrateOpacity(elapsed, WAVE_DURATION_MS);

                wave.mesh.scale.setScalar(radius);
                wave.mesh.material.opacity = opacity * 0.85;

                const node = this.nodeById.get(wave.nodeId);

                if (node !== undefined && node.x !== undefined && node.y !== undefined && node.z !== undefined) {
                    wave.mesh.position.set(node.x, node.y, node.z);
                }

                survivors.push(wave);
            }

            this.waves = survivors;

            if (this.waves.length === 0) {
                this.waveRaf = null;
                return;
            }

            this.waveRaf = requestAnimationFrame(tick);
        };

        this.waveRaf = requestAnimationFrame(tick);
    }

    private rebuild(): void {
        const {nodes, edges, visibleNodeCount, visibleEdgeCount} = filterGraph(this.state);

        this.stats.textContent = `${visibleNodeCount} nodes · ${visibleEdgeCount} edges`;

        const oldById = new Map(this.nodes.map((n) => [n.id, n]));
        const savedPositions = positionsStore3D.get();

        this.nodes = nodes.map((n) => {
            const existing = oldById.get(n.id);
            const radius = 4 + Math.min(4, n.tags.length);
            const record: NodeRecord = {
                id: n.id,
                title: n.title,
                tags: n.tags,
                color: colorForNode(n.tags),
                radius
            };

            if (existing?.sphere !== undefined) {
                record.sphere = existing.sphere;

                if (existing.baseColor !== undefined) {
                    record.baseColor = existing.baseColor;
                }
            }

            // Position precedence: live in-memory > localStorage snapshot >
            // let the force engine spawn it. Restoring across sessions
            // means the user doesn't pay another 15s of CPU-bound settling
            // every time they re-enter the 3D tab.
            const saved = savedPositions[n.id];

            if (existing?.x !== undefined) {
                record.x = existing.x;
            } else if (saved !== undefined) {
                record.x = saved.x;
            }

            if (existing?.y !== undefined) {
                record.y = existing.y;
            } else if (saved !== undefined) {
                record.y = saved.y;
            }

            if (existing?.z !== undefined) {
                record.z = existing.z;
            } else if (saved !== undefined) {
                record.z = saved.z;
            }

            return record;
        });

        this.nodeById.clear();
        for (const record of this.nodes) {
            this.nodeById.set(record.id, record);
        }

        this.links = edges.map((e) => ({source: e.from, target: e.to}));

        this.adjacency.clear();
        for (const link of this.links) {
            this.adjacencyAdd(link.source, link.target);
            this.adjacencyAdd(link.target, link.source);
        }

        if (this.graph === null) {
            // Freeze the render tier on first build from the whole-graph size;
            // it must not flip mid-session (the node three-objects and the
            // instanced mesh are built to match it). makeSphere/installBloom/
            // installParticles/nodeThreeObject all read this below.
            this.lightweight = this.nodes.length >= HEAVY_EFFECTS_MAX_NODES;

            // A positive linkWidth makes 3d-force-graph render every link as a
            // cylinder *mesh*, and a positive arrow length adds a cone mesh per
            // link — on a 5000+ edge graph that is >10k extra draw calls, far
            // more than the nodes themselves. In the lean tier links fall back
            // to batched THREE.Line segments (width 0) and arrows are dropped.
            const linkWidth = this.lightweight ? 0 : 0.4;
            const arrowLength = this.lightweight ? 0 : 2;

            this.graph = new ForceGraph3D(this.canvas)
                .backgroundColor('#000000')
                .showNavInfo(false)
                .nodeRelSize(4)
                .cooldownTicks(COOLDOWN_TICKS)
                .nodeLabel((node: object) => (node as NodeRecord).title)
                // Lean mode renders nodes through a single InstancedMesh, so the
                // library gets an empty placeholder per node (it still tracks
                // x/y/z on it) and we own the visuals + picking.
                .nodeThreeObject((node: object) =>
                    this.lightweight ? new THREE.Object3D() : this.makeSphere(node as NodeRecord))
                // Lean mode draws links itself as one batched LineSegments, so
                // the library's per-link Line objects are switched off.
                .linkVisibility(!this.lightweight)
                .linkColor((link: object) => this.linkColorForHover(link))
                .linkOpacity(0.7)
                .linkWidth(linkWidth)
                .linkDirectionalArrowLength(arrowLength)
                .linkDirectionalArrowRelPos(0.92)
                .linkDirectionalArrowColor(() => 'rgba(180, 190, 210, 0.55)')
                .onNodeClick((node: object) => {
                    const record = node as NodeRecord;
                    this.focusOnNode(record);
                    this.focus(record.id);
                    window.setTimeout(() => this.cb.onSelectNote(record.id), FOCUS_DURATION_MS);
                })
                .onNodeHover((node: object | null) => {
                    this.hoverNodeId = node === null ? null : (node as NodeRecord).id;
                    this.applyHoverHighlight();
                })
                .onNodeDragEnd(() => {
                    this.snapshotPositions();
                })
                .onEngineTick(() => {
                    // Keep instances glued to the force-updated node positions
                    // while the simulation (or a drag) is running.
                    this.markInstancesDirty();
                })
                .onEngineStop(() => {
                    this.hullsDirty = true;
                    this.refreshHulls();
                    this.snapshotPositions();
                    this.markInstancesDirty();
                });

            this.installParticles();
            this.installBloom();
            this.refreshRoomGrid();
            this.refreshClusterForce();
        }

        this.hullsDirty = true;

        this.graph
            .width(this.canvas.clientWidth || 800)
            .height(this.canvas.clientHeight || 600)
            .graphData({nodes: this.nodes, links: this.links});

        if (this.lightweight) {
            this.buildInstances();
            this.buildLinkBatch();
        }
    }

    /**
     * Save current node positions to localStorage so the next mount can
     * skip the force-settling phase. Persistence is debounced inside
     * PersistentValue so rapid drag-end / engine-stop bursts collapse
     * to one JSON.stringify.
     */
    private snapshotPositions(): void {
        if (this.nodes.length === 0) {
            return;
        }

        const next: Position3DMap = {...positionsStore3D.get()};

        for (const node of this.nodes) {
            if (node.x === undefined || node.y === undefined || node.z === undefined) {
                continue;
            }
            next[node.id] = {x: node.x, y: node.y, z: node.z};
        }

        positionsStore3D.set(next);
    }

    public focus(noteId: string): void {
        if (this.graph === null) {
            return;
        }

        const node = this.nodeById.get(noteId);

        if (node === undefined) {
            return;
        }

        this.orbitTargetId = noteId;

        if (this.orbitStartTimer !== null) {
            window.clearTimeout(this.orbitStartTimer);
        }

        this.orbitStartTimer = window.setTimeout(() => {
            this.orbitStartTimer = null;
            this.beginOrbit(noteId);
        }, ORBIT_START_DELAY_MS);
    }

    private beginOrbit(noteId: string): void {
        if (this.graph === null || this.orbitTargetId !== noteId) {
            return;
        }

        const node = this.nodeById.get(noteId);

        if (node === undefined || node.x === undefined || node.y === undefined || node.z === undefined) {
            return;
        }

        const camPos = this.graph.cameraPosition() as {x: number; y: number; z: number};
        const dx = camPos.x - node.x;
        const dz = camPos.z - node.z;
        this.orbitAngle = Math.atan2(dz, dx);
        this.orbitRadius = Math.max(40, Math.hypot(dx, dz));
        this.orbitHeight = camPos.y - node.y;

        if (this.orbitRaf === null) {
            const tick = (): void => {
                if (this.orbitTargetId === null || this.graph === null) {
                    this.orbitRaf = null;
                    return;
                }

                const target = this.orbitTargetId !== null ? this.nodeById.get(this.orbitTargetId) : undefined;

                if (target === undefined || target.x === undefined || target.y === undefined || target.z === undefined) {
                    this.orbitRaf = null;
                    return;
                }

                this.orbitAngle += ORBIT_SPEED_RAD_PER_FRAME;
                const x = target.x + Math.cos(this.orbitAngle) * this.orbitRadius;
                const z = target.z + Math.sin(this.orbitAngle) * this.orbitRadius;
                const y = target.y + this.orbitHeight;

                this.graph.cameraPosition({x, y, z}, {x: target.x, y: target.y, z: target.z}, 0);

                this.orbitRaf = requestAnimationFrame(tick);
            };

            this.orbitRaf = requestAnimationFrame(tick);
        }
    }

    private stopOrbit(): void {
        this.orbitTargetId = null;

        if (this.orbitStartTimer !== null) {
            window.clearTimeout(this.orbitStartTimer);
            this.orbitStartTimer = null;
        }

        if (this.orbitRaf !== null) {
            cancelAnimationFrame(this.orbitRaf);
            this.orbitRaf = null;
        }
    }

    private installParticles(): void {
        if (this.graph === null || this.lightweight) {
            return;
        }

        const particled = this.graph as unknown as {
            linkDirectionalParticles(n: number): unknown;
            linkDirectionalParticleSpeed(s: number): unknown;
            linkDirectionalParticleWidth(w: number): unknown;
            linkDirectionalParticleColor(fn: () => string): unknown;
        };

        particled.linkDirectionalParticles(PARTICLE_COUNT);
        particled.linkDirectionalParticleSpeed(PARTICLE_SPEED);
        particled.linkDirectionalParticleWidth(PARTICLE_WIDTH);
        particled.linkDirectionalParticleColor(() => PARTICLE_COLOR);
    }

    private adjacencyAdd(from: string, to: string): void {
        let set = this.adjacency.get(from);

        if (set === undefined) {
            set = new Set<string>();
            this.adjacency.set(from, set);
        }

        set.add(to);
    }

    private linkColorForHover(link: object): string {
        if (this.hoverNodeId === null) {
            return LINK_COLOR_NORMAL;
        }

        const linkObj = link as {source: NodeRecord | string; target: NodeRecord | string};
        const sourceId = typeof linkObj.source === 'string' ? linkObj.source : linkObj.source.id;
        const targetId = typeof linkObj.target === 'string' ? linkObj.target : linkObj.target.id;

        return sourceId === this.hoverNodeId || targetId === this.hoverNodeId
            ? LINK_COLOR_HIGHLIGHT
            : LINK_COLOR_DIM;
    }

    private applyHoverHighlight(): void {
        const highlight = this.computeHighlightSet();
        this.highlightSet = highlight;

        if (this.graph !== null) {
            this.graph.linkColor((link: object) => this.linkColorForHover(link));
        }

        if (this.instanced !== null) {
            // Lean mode: dimming is a per-instance color multiply.
            this.markInstancesDirty();
            return;
        }

        for (const node of this.nodes) {
            if (node.sphere === undefined) {
                continue;
            }

            const dimmed = highlight !== null && !highlight.has(node.id);
            const mat = node.sphere.material;

            // Only dimmed spheres need blending; keep the rest opaque so the
            // common (no-hover) case never pays the transparent-sort cost.
            // Toggling `transparent` requires a shader recompile flag, but this
            // fires only on hover so the cost is negligible.
            if (dimmed) {
                if (!mat.transparent) {
                    mat.transparent = true;
                    mat.needsUpdate = true;
                }
                mat.opacity = NODE_OPACITY_DIM;
            } else {
                if (mat.transparent) {
                    mat.transparent = false;
                    mat.needsUpdate = true;
                }
                mat.opacity = NODE_OPACITY_NORMAL;
            }
        }
    }

    private computeHighlightSet(): Set<string> | null {
        if (this.hoverNodeId === null) {
            return null;
        }

        const set = new Set<string>([this.hoverNodeId]);
        const neighbors = this.adjacency.get(this.hoverNodeId);

        if (neighbors !== undefined) {
            for (const id of neighbors) {
                set.add(id);
            }
        }

        return set;
    }

    private refreshHulls(): void {
        if (this.graph === null) {
            return;
        }

        if (!this.state.showHulls) {
            this.disposeHulls();
            return;
        }

        if (!this.hullsDirty) {
            return;
        }

        this.disposeHulls();

        const tagToPoints = new Map<string, THREE.Vector3[]>();

        for (const node of this.nodes) {
            if (node.x === undefined || node.y === undefined || node.z === undefined) {
                continue;
            }

            const point = new THREE.Vector3(node.x, node.y, node.z);

            for (const tag of node.tags) {
                const points = tagToPoints.get(tag) ?? [];
                points.push(point);
                tagToPoints.set(tag, points);
            }
        }

        const group = new THREE.Group();

        for (const [tag, points] of tagToPoints) {
            if (points.length < HULL_MIN_POINTS) {
                continue;
            }

            try {
                const hullObject = this.buildHullObject(tag, points);

                if (hullObject !== null) {
                    group.add(hullObject);
                }
            } catch {
                // ConvexGeometry throws on degenerate (coplanar) input — skip this tag silently
            }
        }

        this.graph.scene().add(group);
        this.hullGroup = group;
        this.hullsDirty = false;
    }

    private buildHullObject(tag: string, points: THREE.Vector3[]): THREE.Object3D | null {
        const color = new THREE.Color(tagColor(tag));

        const fillGeometry = new ConvexGeometry(points);
        const fillMaterial = new THREE.MeshBasicMaterial({
            color: color.clone(),
            transparent: true,
            opacity: HULL_FILL_OPACITY,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        const fill = new THREE.Mesh(fillGeometry, fillMaterial);

        const edgeGeometry = new THREE.EdgesGeometry(fillGeometry);
        const edgeMaterial = new THREE.LineBasicMaterial({
            color: color.clone(),
            transparent: true,
            opacity: HULL_EDGE_OPACITY,
            depthWrite: false
        });
        const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);

        const centroid = new THREE.Vector3();
        for (const p of points) {
            centroid.add(p);
        }
        centroid.divideScalar(points.length);

        const box = new THREE.Box3().setFromPoints(points);
        const labelY = box.max.y + 4;
        const label = this.buildTagLabel(tag, tagColor(tag));
        label.position.set(centroid.x, labelY, centroid.z);

        const wrapper = new THREE.Group();
        wrapper.add(fill);
        wrapper.add(edges);
        wrapper.add(label);
        return wrapper;
    }

    private buildTagLabel(tag: string, color: string): THREE.Sprite {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');

        if (ctx !== null) {
            ctx.font = '600 36px -apple-system, "Segoe UI", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = '#000000';
            ctx.shadowBlur = 8;
            ctx.fillStyle = color;
            ctx.fillText(tag, canvas.width / 2, canvas.height / 2);
        }

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.needsUpdate = true;

        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
            depthTest: false
        });
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(HULL_LABEL_SCALE, HULL_LABEL_SCALE / 4, 1);
        return sprite;
    }

    private disposeHulls(): void {
        if (this.hullGroup === null) {
            return;
        }

        this.hullGroup.traverse((obj) => {
            if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
                obj.geometry.dispose();

                if (Array.isArray(obj.material)) {
                    for (const mat of obj.material) {
                        mat.dispose();
                    }
                } else {
                    obj.material.dispose();
                }
            } else if (obj instanceof THREE.Sprite) {
                if (obj.material.map !== null) {
                    obj.material.map.dispose();
                }
                obj.material.dispose();
            }
        });

        this.hullGroup.parent?.remove(this.hullGroup);
        this.hullGroup = null;
    }

    private computeTagAnchors(): void {
        const tagSet = new Set<string>();

        for (const node of this.nodes) {
            for (const tag of node.tags) {
                tagSet.add(tag);
            }
        }

        const sorted = [...tagSet].sort();
        const total = Math.max(1, sorted.length);
        const goldenAngle = Math.PI * (3 - Math.sqrt(5));

        this.tagAnchors.clear();

        sorted.forEach((tag, i) => {
            const yNorm = total === 1 ? 0 : 1 - (i / (total - 1)) * 2;
            const r = Math.sqrt(Math.max(0, 1 - yNorm * yNorm));
            const theta = goldenAngle * i;

            this.tagAnchors.set(tag, {
                x: CLUSTER_ANCHOR_RADIUS * Math.cos(theta) * r,
                y: CLUSTER_ANCHOR_RADIUS * yNorm,
                z: CLUSTER_ANCHOR_RADIUS * Math.sin(theta) * r
            });
        });
    }

    private refreshClusterForce(): void {
        if (this.graph === null) {
            return;
        }

        const forced = this.graph as unknown as {
            d3Force(name: string, force: unknown): unknown;
            d3ReheatSimulation(): unknown;
        };

        if (!this.state.showCluster) {
            if (this.clusterForceAttached) {
                forced.d3Force('cluster', null);
                this.clusterForceAttached = false;
                forced.d3ReheatSimulation();
            }
            return;
        }

        this.computeTagAnchors();

        const tagAnchors = this.tagAnchors;
        let simNodes: SimNode[] = [];

        const force = ((alpha: number): void => {
            const strength = CLUSTER_STRENGTH * alpha;

            for (const node of simNodes) {
                const primaryTag = node.tags[0];

                if (primaryTag === undefined) {
                    continue;
                }

                const anchor = tagAnchors.get(primaryTag);

                if (anchor === undefined || node.x === undefined || node.y === undefined || node.z === undefined) {
                    continue;
                }

                node.vx += (anchor.x - node.x) * strength;
                node.vy += (anchor.y - node.y) * strength;
                node.vz += (anchor.z - node.z) * strength;
            }
        }) as ((alpha: number) => void) & {initialize: (nodes: SimNode[]) => void};

        force.initialize = (nodes: SimNode[]): void => {
            simNodes = nodes;
        };

        forced.d3Force('cluster', force);
        this.clusterForceAttached = true;
        forced.d3ReheatSimulation();
    }

    private refreshRoomGrid(): void {
        if (this.graph === null) {
            return;
        }

        if (!this.state.showRoomGrid) {
            this.disposeRoomGrid();
            return;
        }

        if (this.roomGridGroup !== null) {
            return;
        }

        const group = new THREE.Group();
        const half = ROOM_GRID_SIZE / 2;
        const step = ROOM_GRID_SIZE / ROOM_GRID_DIVISIONS;
        const positions: number[] = [];

        for (let i = 0; i <= ROOM_GRID_DIVISIONS; i++) {
            for (let j = 0; j <= ROOM_GRID_DIVISIONS; j++) {
                const a = -half + i * step;
                const b = -half + j * step;

                positions.push(-half, a, b, half, a, b);
                positions.push(a, -half, b, a, half, b);
                positions.push(a, b, -half, a, b, half);
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

        const material = new THREE.LineBasicMaterial({
            color: ROOM_GRID_COLOR,
            transparent: true,
            opacity: ROOM_GRID_OPACITY,
            depthWrite: false
        });

        const lattice = new THREE.LineSegments(geometry, material);
        group.add(lattice);

        this.graph.scene().add(group);
        this.roomGridGroup = group;
    }

    private disposeRoomGrid(): void {
        if (this.roomGridGroup === null) {
            return;
        }

        this.roomGridGroup.traverse((obj) => {
            if (obj instanceof THREE.LineSegments) {
                obj.geometry.dispose();

                if (Array.isArray(obj.material)) {
                    for (const m of obj.material) {
                        m.dispose();
                    }
                } else {
                    obj.material.dispose();
                }
            }
        });

        this.roomGridGroup.parent?.remove(this.roomGridGroup);
        this.roomGridGroup = null;
    }

    private installBloom(): void {
        if (this.graph === null || this.lightweight) {
            return;
        }

        const composer = this.graph.postProcessingComposer();
        const bloom = new UnrealBloomPass(
            new THREE.Vector2(this.canvas.clientWidth || 800, this.canvas.clientHeight || 600),
            BLOOM_STRENGTH,
            BLOOM_RADIUS,
            BLOOM_THRESHOLD
        );

        composer.addPass(bloom);
        composer.addPass(new OutputPass());
    }

    private focusOnNode(record: NodeRecord): void {
        if (this.graph === null || record.x === undefined || record.y === undefined || record.z === undefined) {
            return;
        }

        const camPos = this.graph.cameraPosition();
        const dx = camPos.x - record.x;
        const dy = camPos.y - record.y;
        const dz = camPos.z - record.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const scale = FOCUS_DISTANCE / len;

        this.graph.cameraPosition(
            {x: record.x + dx * scale, y: record.y + dy * scale, z: record.z + dz * scale},
            {x: record.x, y: record.y, z: record.z},
            FOCUS_DURATION_MS
        );
    }

    private sphereGeometry(radius: number): THREE.SphereGeometry {
        const segments = this.lightweight ? SPHERE_SEGMENTS_LEAN : SPHERE_SEGMENTS_RICH;
        const key = `${radius}:${segments}`;
        let geom = this.sphereGeoCache.get(key);

        if (geom === undefined) {
            geom = new THREE.SphereGeometry(radius, segments, segments);
            this.sphereGeoCache.set(key, geom);
        }

        return geom;
    }

    private makeSphere(record: NodeRecord): THREE.Object3D {
        const geom = this.sphereGeometry(record.radius);
        const baseColor = new THREE.Color(record.color);
        // Opaque by default: transparent:true would make three.js depth-sort
        // every sphere each frame and skip early-z. Hover dimming re-enables
        // transparency only on the dimmed subset (see applyHoverHighlight).
        const mat = new THREE.MeshLambertMaterial({
            color: baseColor.clone(),
            emissive: baseColor.clone().multiplyScalar(0.25),
            transparent: false,
            opacity: 1
        });
        const sphere = new THREE.Mesh(geom, mat);
        record.sphere = sphere;
        record.baseColor = baseColor;
        return sphere;
    }

    // ---- Lean-mode instanced rendering ------------------------------------

    /**
     * (Re)build the single InstancedMesh that draws every node in lean mode.
     * One unit sphere geometry, one material, N instances — the whole graph
     * is a single draw call instead of one per node.
     */
    private buildInstances(): void {
        this.disposeInstances();

        const scene = this.graph?.scene();

        if (scene === undefined || this.nodes.length === 0) {
            return;
        }

        const geom = new THREE.SphereGeometry(1, SPHERE_SEGMENTS_LEAN, SPHERE_SEGMENTS_LEAN);
        // A little baked emissive keeps nodes vivid without bloom; per-instance
        // color still carries the actual hue via instanceColor.
        const mat = new THREE.MeshLambertMaterial({color: 0xffffff, emissive: 0x111111});
        const mesh = new THREE.InstancedMesh(geom, mat, this.nodes.length);
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

        for (let i = 0; i < this.nodes.length; i += 1) {
            const node = this.nodes[i];

            if (node === undefined) {
                continue;
            }

            node.index = i;
            node.baseColor = new THREE.Color(node.color);
        }

        this.instanced = mesh;
        this.instanceGeom = geom;
        this.instanceMat = mat;
        scene.add(mesh);

        this.refreshInstances();
    }

    private disposeInstances(): void {
        if (this.syncRaf !== null) {
            cancelAnimationFrame(this.syncRaf);
            this.syncRaf = null;
        }
        if (this.instanced !== null) {
            this.instanced.parent?.remove(this.instanced);
            this.instanced.dispose();
            this.instanced = null;
        }
        this.instanceGeom?.dispose();
        this.instanceGeom = null;
        this.instanceMat?.dispose();
        this.instanceMat = null;
        this.disposeLinkBatch();
    }

    /** Build the single LineSegments buffer that draws every link. */
    private buildLinkBatch(): void {
        this.disposeLinkBatch();

        const scene = this.graph?.scene();

        if (scene === undefined || this.links.length === 0) {
            return;
        }

        const positions = new Float32Array(this.links.length * 6);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute(
            'position',
            new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage)
        );
        const mat = new THREE.LineBasicMaterial({color: 0x9aa4b8, transparent: true, opacity: 0.32});
        const lines = new THREE.LineSegments(geom, mat);
        lines.frustumCulled = false;

        this.linkLines = lines;
        this.linkPositions = positions;
        scene.add(lines);

        this.refreshLinkPositions();
    }

    private refreshLinkPositions(): void {
        const positions = this.linkPositions;
        const lines = this.linkLines;

        if (positions === null || lines === null) {
            return;
        }

        for (let i = 0; i < this.links.length; i += 1) {
            const link = this.links[i];

            if (link === undefined) {
                continue;
            }

            // graphData() mutates each link, swapping the source/target string
            // ids for the live node objects — resolve either form.
            const from = this.resolveEndpoint(link.source);
            const to = this.resolveEndpoint(link.target);
            const o = i * 6;

            positions[o] = from?.x ?? 0;
            positions[o + 1] = from?.y ?? 0;
            positions[o + 2] = from?.z ?? 0;
            positions[o + 3] = to?.x ?? 0;
            positions[o + 4] = to?.y ?? 0;
            positions[o + 5] = to?.z ?? 0;
        }

        (lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }

    private resolveEndpoint(ref: string | NodeRecord): {x?: number; y?: number; z?: number} | undefined {
        if (typeof ref === 'string') {
            return this.nodeById.get(ref);
        }

        // Already a live node object (library-mutated link endpoint).
        return ref;
    }

    private disposeLinkBatch(): void {
        if (this.linkLines !== null) {
            this.linkLines.parent?.remove(this.linkLines);
            this.linkLines.geometry.dispose();
            this.linkLines.material.dispose();
            this.linkLines = null;
        }
        this.linkPositions = null;
    }

    /** Write current position/scale/color for every instance in one pass. */
    private refreshInstances(): void {
        const mesh = this.instanced;

        if (mesh === null) {
            return;
        }

        const now = Date.now();
        let stillAnimating = false;

        for (let i = 0; i < this.nodes.length; i += 1) {
            const node = this.nodes[i];

            if (node === undefined) {
                continue;
            }

            const base = node.baseColor ?? this.tmpColor.set(node.color);

            this.tmpPos.set(node.x ?? 0, node.y ?? 0, node.z ?? 0);
            this.tmpColor.copy(base);
            let scale = 1;

            if (node.pulseUntil !== undefined) {
                const remaining = node.pulseUntil - now;

                if (remaining > 0) {
                    const t = 1 - remaining / PULSE_DURATION_MS;
                    const intensity = 1 - easeOutCubic(t);
                    this.tmpColor.copy(base).lerp(node.pulseColor ?? base, intensity);
                    scale = 1 + intensity * 0.9;
                    stillAnimating = true;
                } else {
                    delete node.pulseUntil;
                    delete node.pulseColor;
                }
            }

            if (node.pulseUntil === undefined) {
                const raw = this.heatById?.get(node.id) ?? 0;
                const heat = Math.min(1, Math.max(0, raw / 5));

                if (this.state.showHeat && heat > 0) {
                    this.tmpColor.copy(base).lerp(this.hotColor, 0.3 + heat * 0.5);
                    scale = 1 + heat * 0.4;
                }
            }

            if (this.highlightSet !== null && !this.highlightSet.has(node.id)) {
                this.tmpColor.multiplyScalar(0.22);
            }

            const r = node.radius * scale;
            this.tmpScale.set(r, r, r);
            this.tmpMatrix.compose(this.tmpPos, this.identityQuat, this.tmpScale);
            mesh.setMatrixAt(i, this.tmpMatrix);
            mesh.setColorAt(i, this.tmpColor);
        }

        mesh.instanceMatrix.needsUpdate = true;

        if (mesh.instanceColor !== null) {
            mesh.instanceColor.needsUpdate = true;
        }

        // Links share the same position source, so refresh them in lock-step.
        this.refreshLinkPositions();

        // A live pulse means the next frame is different — keep the loop going.
        if (stillAnimating) {
            this.instancesDirty = true;
        }
    }

    private markInstancesDirty(): void {
        if (this.instanced === null) {
            return;
        }

        this.instancesDirty = true;
        this.ensureInstanceSync();
    }

    /**
     * Self-stopping rAF: repaints instances whenever they are dirty, then
     * winds down after a few idle frames so a settled graph costs nothing.
     */
    private ensureInstanceSync(): void {
        if (this.syncRaf !== null) {
            return;
        }

        let idle = 0;
        const tick = (): void => {
            if (this.instanced === null) {
                this.syncRaf = null;
                return;
            }

            if (this.instancesDirty) {
                this.instancesDirty = false;
                this.refreshInstances();
                idle = 0;
            } else {
                idle += 1;

                if (idle > 3) {
                    this.syncRaf = null;
                    return;
                }
            }

            this.syncRaf = requestAnimationFrame(tick);
        };

        this.syncRaf = requestAnimationFrame(tick);
    }

    /** Raycast the instanced mesh under the pointer; map hit → node. */
    private pickNodeAt(ev: PointerEvent): NodeRecord | null {
        if (this.instanced === null || this.graph === null) {
            return null;
        }

        const rect = this.canvas.getBoundingClientRect();

        if (rect.width === 0 || rect.height === 0) {
            return null;
        }

        this.tmpNdc.set(
            ((ev.clientX - rect.left) / rect.width) * 2 - 1,
            -((ev.clientY - rect.top) / rect.height) * 2 + 1
        );

        const camera = this.graph.camera() as THREE.Camera;
        this.raycaster.setFromCamera(this.tmpNdc, camera);

        const hit = this.raycaster.intersectObject(this.instanced, false)[0];

        if (hit === undefined || hit.instanceId === undefined || hit.instanceId === null) {
            return null;
        }

        return this.nodes[hit.instanceId] ?? null;
    }

    private updateTooltip(node: NodeRecord | null, ev: PointerEvent): void {
        if (this.tooltip === null) {
            this.element.style.position = 'relative';
            this.tooltip = el('div', {class: 'graph-3d-tooltip'});
            this.tooltip.style.cssText =
                'position:absolute;pointer-events:none;z-index:20;padding:2px 8px;border-radius:6px;'
                + 'background:rgba(15,18,28,0.92);color:#e8ecf4;font-size:12px;line-height:1.4;'
                + 'white-space:nowrap;transform:translate(-50%,calc(-100% - 12px));display:none;';
            this.element.appendChild(this.tooltip);
        }

        if (node === null) {
            this.tooltip.style.display = 'none';
            this.canvas.style.cursor = '';
            return;
        }

        const rect = this.canvas.getBoundingClientRect();
        this.tooltip.textContent = node.title;
        this.tooltip.style.left = `${ev.clientX - rect.left}px`;
        this.tooltip.style.top = `${ev.clientY - rect.top}px`;
        this.tooltip.style.display = 'block';
        this.canvas.style.cursor = 'pointer';
    }

    private startAnimating(): void {
        if (this.animating) {
            return;
        }

        this.animating = true;
        const tick = (): void => {
            const now = Date.now();
            let active = 0;

            for (const node of this.nodes) {
                if (node.sphere === undefined || node.pulseUntil === undefined || node.baseColor === undefined) {
                    continue;
                }

                const remaining = node.pulseUntil - now;

                if (remaining <= 0) {
                    node.sphere.material.color.copy(node.baseColor);
                    node.sphere.material.emissive.copy(node.baseColor).multiplyScalar(0.25);
                    node.sphere.scale.setScalar(1);
                    delete node.pulseUntil;
                    delete node.pulseColor;
                    continue;
                }

                const t = 1 - remaining / PULSE_DURATION_MS;
                const ease = easeOutCubic(t);
                const intensity = 1 - ease;
                const pulseColor = node.pulseColor ?? node.baseColor;

                node.sphere.material.color.copy(node.baseColor).lerp(pulseColor, intensity);
                node.sphere.material.emissive.copy(pulseColor).multiplyScalar(0.65 * intensity);
                node.sphere.scale.setScalar(1 + intensity * 0.9);

                active += 1;
            }

            if (active === 0) {
                this.animating = false;
                this.rafHandle = null;
                return;
            }

            this.rafHandle = requestAnimationFrame(tick);
        };

        this.rafHandle = requestAnimationFrame(tick);
    }
}