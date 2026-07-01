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
    private pointerUpHandler: (() => void) | null = null;
    private pointerDownPos: {x: number; y: number} | null = null;
    private hoverNodeId: string | null = null;
    private adjacency = new Map<string, Set<string>>();
    private hullGroup: THREE.Group | null = null;
    private hullsDirty = false;
    private roomGridGroup: THREE.Group | null = null;
    private clusterForceAttached = false;
    private tagAnchors = new Map<string, {x: number; y: number; z: number}>();

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
            if (this.pointerDownPos === null) {
                return;
            }

            const dx = ev.clientX - this.pointerDownPos.x;
            const dy = ev.clientY - this.pointerDownPos.y;

            if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
                this.stopOrbit();
                this.pointerDownPos = null;
            }
        };
        this.pointerUpHandler = () => {
            this.pointerDownPos = null;
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

        this.resizeObserver?.disconnect();
        this.resizeObserver = null;

        if (this.graph !== null) {
            this.graph._destructor();
            this.graph = null;
        }
    }

    public applyHeat(heatById: ReadonlyMap<string, number>): void {
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

            if (node === undefined || node.sphere === undefined) {
                continue;
            }

            node.pulseUntil = expiresAt;
            node.pulseColor = color;
            any = true;
        }

        if (any) {
            this.startAnimating();
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
            this.graph = new ForceGraph3D(this.canvas)
                .backgroundColor('#000000')
                .showNavInfo(false)
                .nodeRelSize(4)
                .cooldownTicks(COOLDOWN_TICKS)
                .nodeLabel((node: object) => (node as NodeRecord).title)
                .nodeThreeObject((node: object) => this.makeSphere(node as NodeRecord))
                .linkColor((link: object) => this.linkColorForHover(link))
                .linkOpacity(0.7)
                .linkWidth(0.4)
                .linkDirectionalArrowLength(2)
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
                .onEngineStop(() => {
                    this.hullsDirty = true;
                    this.refreshHulls();
                    this.snapshotPositions();
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
        if (this.graph === null) {
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

        for (const node of this.nodes) {
            if (node.sphere === undefined) {
                continue;
            }

            const dimmed = highlight !== null && !highlight.has(node.id);
            node.sphere.material.opacity = dimmed ? NODE_OPACITY_DIM : NODE_OPACITY_NORMAL;
        }

        if (this.graph !== null) {
            this.graph.linkColor((link: object) => this.linkColorForHover(link));
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
        if (this.graph === null) {
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

    private makeSphere(record: NodeRecord): THREE.Object3D {
        const geom = new THREE.SphereGeometry(record.radius, 18, 18);
        const baseColor = new THREE.Color(record.color);
        const mat = new THREE.MeshLambertMaterial({
            color: baseColor.clone(),
            emissive: baseColor.clone().multiplyScalar(0.25),
            transparent: true,
            opacity: 0.95
        });
        const sphere = new THREE.Mesh(geom, mat);
        record.sphere = sphere;
        record.baseColor = baseColor;
        return sphere;
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