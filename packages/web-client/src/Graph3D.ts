import ForceGraph3D, {ForceGraph3DInstance} from '3d-force-graph';
import * as THREE from 'three';
import {el} from './Dom.js';
import type {EventKind} from './Events.js';
import {ClusterForce} from './Graph3DCluster.js';
import {flyTo, Orbit3D, Trails3D, Waves3D} from './Graph3DEffects.js';
import {LeanLayer, LeanTooltip, SPHERE_SEGMENTS_LEAN} from './Graph3DLean.js';
import {
    buildAdjacency,
    buildNodeRecords,
    FOCUS_DURATION_MS,
    highlightSetFor,
    linkColorForHover,
    loadSavedPositions,
    PULSE_DURATION_MS,
    savePositions,
    type EndpointRef,
    type LinkRecord,
    type NodeRecord
} from './Graph3DModel.js';
import {RichNodes} from './Graph3DRich.js';
import {installBloom, installParticles, RoomGrid, TagHulls} from './Graph3DScene.js';
import type {GraphRenderer, GraphRendererCallbacks, GraphRendererState} from './GraphRenderer.js';
import {filterGraph, PULSE_COLORS} from './GraphRenderer.js';

/**
 * 3D graph view on 3d-force-graph / three.js (plan P7 / D2: split into
 * Graph3DModel, Graph3DRich, Graph3DLean, Graph3DEffects, Graph3DScene
 * and Graph3DCluster). This class owns the force-graph instance, the
 * node/link records, hover state and pointer handling, and routes each
 * renderer call to the active render tier.
 */

/**
 * How many force-simulation ticks the engine is allowed to run after a
 * (re)build. The library default is Infinity, capped by a 15s wall-clock
 * timer — which on a multi-thousand-node vault burns CPU for the full
 * 15s because every tick is O(N log N). With saved positions restored as
 * seeds, ~80 ticks is enough to settle visible drift without staying
 * busy for seconds at a time.
 */
const COOLDOWN_TICKS = 80;

// Above this visible-node count the per-frame cost of the full-fat look
// (fullscreen UnrealBloom, link particles, high-poly *transparent* spheres)
// collapses the frame rate to ~6 FPS on a multi-thousand-node vault — the
// transparent flag alone forces three.js to depth-sort every sphere each
// frame and disables z-culling. Above the threshold we switch to a lean
// path: opaque low-poly spheres, no bloom, no particles. Below it the graph
// is small enough that the rich look stays smooth.
const HEAVY_EFFECTS_MAX_NODES = 1200;
const SPHERE_SEGMENTS_RICH = 18;
const DRAG_THRESHOLD_PX = 5;

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
    private adjacency = new Map<string, Set<string>>();
    private hoverNodeId: string | null = null;
    private highlightSet: Set<string> | null = null;
    private heatById: ReadonlyMap<string, number> | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private pointerDownHandler: ((ev: PointerEvent) => void) | null = null;
    private pointerMoveHandler: ((ev: PointerEvent) => void) | null = null;
    private pointerUpHandler: ((ev: PointerEvent) => void) | null = null;
    private pointerDownPos: {x: number; y: number} | null = null;
    private hullsDirty = false;
    // Set once on first build from the node count; gates bloom/particles and
    // the low-poly sphere path. See HEAVY_EFFECTS_MAX_NODES.
    private lightweight = false;

    private readonly nodeOf = (id: string): NodeRecord | undefined => this.nodeById.get(id);
    private readonly rich = new RichNodes(() => this.nodes);
    private readonly lean = new LeanLayer(() => ({
        nodes: this.nodes,
        links: this.links,
        nodeById: this.nodeById,
        heatById: this.heatById,
        showHeat: this.state.showHeat,
        highlight: this.highlightSet
    }));
    private readonly tooltip: LeanTooltip;
    private readonly trails = new Trails3D(this.nodeOf);
    private readonly waves = new Waves3D(this.nodeOf);
    private readonly orbit = new Orbit3D(() => this.graph, this.nodeOf);
    private readonly hulls = new TagHulls();
    private readonly roomGrid = new RoomGrid();
    private readonly cluster = new ClusterForce();

    public constructor(initial: GraphRendererState, private readonly cb: GraphRendererCallbacks) {
        this.state = initial;
        this.element = el('div', {class: 'graph-canvas graph-canvas-3d'});
        this.stats = el('div', {class: 'graph-stats'});
        this.canvas = el('div', {class: 'graph'});
        this.element.appendChild(this.stats);
        this.element.appendChild(this.canvas);
        this.tooltip = new LeanTooltip(this.element, this.canvas);
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

        this.pointerDownHandler = (ev) => {
            this.pointerDownPos = {x: ev.clientX, y: ev.clientY};
        };
        this.pointerMoveHandler = (ev) => {
            if (this.pointerDownPos !== null) {
                const dx = ev.clientX - this.pointerDownPos.x;
                const dy = ev.clientY - this.pointerDownPos.y;

                if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
                    this.orbit.stop();
                    this.pointerDownPos = null;
                }
            }

            // Lean mode owns its own hover picking (the library has no per-node
            // mesh to raycast). Skip while a drag is in progress.
            if (this.lean.active && this.pointerDownPos === null) {
                const picked = this.pickNodeAt(ev);
                const id = picked === null ? null : picked.id;

                if (id !== this.hoverNodeId) {
                    this.hoverNodeId = id;
                    this.applyHoverHighlight();
                }

                this.tooltip.update(picked, ev);
            }
        };
        this.pointerUpHandler = (ev) => {
            // A pointerup that never crossed the drag threshold (pointerDownPos
            // still set) is a click — pick the node under it and open it.
            const wasClick = this.pointerDownPos !== null;
            this.pointerDownPos = null;

            if (wasClick && this.lean.active) {
                const picked = this.pickNodeAt(ev);

                if (picked !== null) {
                    this.openNode(picked);
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
        this.trails.dispose();
        this.waves.dispose();
        this.orbit.stop();

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

        this.hulls.dispose();
        this.roomGrid.dispose();
        this.lean.dispose();
        this.tooltip.dispose();

        this.resizeObserver?.disconnect();
        this.resizeObserver = null;

        if (this.graph !== null) {
            this.graph._destructor();
            this.graph = null;
        }

        this.rich.dispose();
    }

    public applyHeat(heatById: ReadonlyMap<string, number>): void {
        if (this.lean.active) {
            // Lean mode: heat is folded into the per-instance color/scale pass.
            this.heatById = heatById;
            this.lean.markDirty();
            return;
        }

        this.rich.applyHeat(heatById, this.state.showHeat);
    }

    public trail(fromId: string, toId: string, kind: EventKind): void {
        if (this.graph === null || fromId === toId) {
            return;
        }

        const from = this.nodeById.get(fromId);
        const to = this.nodeById.get(toId);

        if (from === undefined || to === undefined || from.x === undefined || to.x === undefined) {
            return;
        }

        this.trails.add(this.graph.scene(), from, to, PULSE_COLORS[kind]);
    }

    public pulse(noteIds: readonly string[], kind: EventKind): void {
        const color = new THREE.Color(PULSE_COLORS[kind]);
        const expiresAt = Date.now() + PULSE_DURATION_MS;
        let any = false;

        for (const id of noteIds) {
            const node = this.nodeById.get(id);

            // Rich mode animates node.sphere; lean mode animates the instance.
            if (node === undefined || (!this.lean.active && node.sphere === undefined)) {
                continue;
            }

            node.pulseUntil = expiresAt;
            node.pulseColor = color;
            any = true;
        }

        if (any) {
            if (this.lean.active) {
                this.lean.markDirty();
            } else {
                this.rich.animatePulses();
            }
        }
    }

    public concentrate(noteId: string): void {
        const node = this.nodeById.get(noteId);

        if (this.graph === null || node === undefined) {
            return;
        }

        this.waves.concentrate(this.graph.scene(), node);
    }

    public focus(noteId: string): void {
        if (this.graph === null || !this.nodeById.has(noteId)) {
            return;
        }

        this.orbit.start(noteId);
    }

    /** Click on a node: fly there, orbit, then hand the note to the app. */
    private openNode(record: NodeRecord): void {
        if (this.graph !== null) {
            flyTo(this.graph, record);
        }
        this.focus(record.id);
        window.setTimeout(() => this.cb.onSelectNote(record.id), FOCUS_DURATION_MS);
    }

    private rebuild(): void {
        const {nodes, edges, visibleNodeCount, visibleEdgeCount} = filterGraph(this.state);

        this.stats.textContent = `${visibleNodeCount} nodes · ${visibleEdgeCount} edges`;

        this.nodes = buildNodeRecords(nodes, this.nodeById, loadSavedPositions());
        this.nodeById = new Map(this.nodes.map((n) => [n.id, n]));
        this.links = edges.map((e) => ({source: e.from, target: e.to}));
        this.adjacency = buildAdjacency(this.links);

        if (this.graph === null) {
            this.graph = this.createGraph();
        }

        this.hullsDirty = true;

        this.graph
            .width(this.canvas.clientWidth || 800)
            .height(this.canvas.clientHeight || 600)
            .graphData({nodes: this.nodes, links: this.links});

        if (this.lightweight) {
            this.lean.build(this.graph.scene());
        }
    }

    private createGraph(): ForceGraph3DInstance {
        // Freeze the render tier on first build from the whole-graph size;
        // it must not flip mid-session (the node three-objects and the
        // instanced mesh are built to match it).
        this.lightweight = this.nodes.length >= HEAVY_EFFECTS_MAX_NODES;

        // A positive linkWidth makes 3d-force-graph render every link as a
        // cylinder *mesh*, and a positive arrow length adds a cone mesh per
        // link — on a 5000+ edge graph that is >10k extra draw calls, far
        // more than the nodes themselves. In the lean tier links fall back
        // to batched THREE.Line segments (width 0) and arrows are dropped.
        const linkWidth = this.lightweight ? 0 : 0.4;
        const arrowLength = this.lightweight ? 0 : 2;
        const segments = this.lightweight ? SPHERE_SEGMENTS_LEAN : SPHERE_SEGMENTS_RICH;

        const graph = new ForceGraph3D(this.canvas)
            .backgroundColor('#000000')
            .showNavInfo(false)
            .nodeRelSize(4)
            .cooldownTicks(COOLDOWN_TICKS)
            .nodeLabel((node: object) => (node as NodeRecord).title)
            // Lean mode renders nodes through a single InstancedMesh, so the
            // library gets an empty placeholder per node (it still tracks
            // x/y/z on it) and we own the visuals + picking.
            .nodeThreeObject((node: object) =>
                this.lightweight ? new THREE.Object3D() : this.rich.makeSphere(node as NodeRecord, segments))
            // Lean mode draws links itself as one batched LineSegments, so
            // the library's per-link Line objects are switched off.
            .linkVisibility(!this.lightweight)
            .linkColor((link: object) => this.linkColor(link))
            .linkOpacity(0.7)
            .linkWidth(linkWidth)
            .linkDirectionalArrowLength(arrowLength)
            .linkDirectionalArrowRelPos(0.92)
            .linkDirectionalArrowColor(() => 'rgba(180, 190, 210, 0.55)')
            .onNodeClick((node: object) => this.openNode(node as NodeRecord))
            .onNodeHover((node: object | null) => {
                this.hoverNodeId = node === null ? null : (node as NodeRecord).id;
                this.applyHoverHighlight();
            })
            .onNodeDragEnd(() => {
                savePositions(this.nodes);
            })
            .onEngineTick(() => {
                // Keep instances glued to the force-updated node positions
                // while the simulation (or a drag) is running.
                this.lean.markDirty();
            })
            .onEngineStop(() => {
                this.hullsDirty = true;
                this.refreshHulls();
                savePositions(this.nodes);
                this.lean.markDirty();
            });

        // The refresh* helpers below read this.graph, so assign it first.
        this.graph = graph;

        if (!this.lightweight) {
            installParticles(graph);
            installBloom(graph, this.canvas.clientWidth || 800, this.canvas.clientHeight || 600);
        }
        this.refreshRoomGrid();
        this.refreshClusterForce();

        return graph;
    }

    private linkColor(link: object): string {
        return linkColorForHover(link as {source: EndpointRef; target: EndpointRef}, this.hoverNodeId);
    }

    private applyHoverHighlight(): void {
        this.highlightSet = highlightSetFor(this.hoverNodeId, this.adjacency);

        if (this.graph !== null) {
            this.graph.linkColor((link: object) => this.linkColor(link));
        }

        if (this.lean.active) {
            // Lean mode: dimming is a per-instance color multiply.
            this.lean.markDirty();
            return;
        }

        this.rich.applyDim(this.highlightSet);
    }

    private refreshHulls(): void {
        if (this.graph === null) {
            return;
        }

        if (!this.state.showHulls) {
            this.hulls.dispose();
            return;
        }

        if (!this.hullsDirty) {
            return;
        }

        this.hulls.rebuild(this.graph.scene(), this.nodes);
        this.hullsDirty = false;
    }

    private refreshRoomGrid(): void {
        if (this.graph === null) {
            return;
        }

        if (this.state.showRoomGrid) {
            this.roomGrid.show(this.graph.scene());
        } else {
            this.roomGrid.dispose();
        }
    }

    private refreshClusterForce(): void {
        if (this.graph !== null) {
            this.cluster.refresh(this.graph, this.state.showCluster, this.nodes);
        }
    }

    private pickNodeAt(ev: PointerEvent): NodeRecord | null {
        if (this.graph === null) {
            return null;
        }

        return this.lean.pick(ev, this.canvas, this.graph.camera() as THREE.Camera);
    }
}
