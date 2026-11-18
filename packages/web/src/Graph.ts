import type {NGraph, NGraphEdgeData, NGraphHull, NGraphNodeData, NGraphOptions} from 'jsngraph';
import type {Graph as GraphData} from '@synaipse/core';
import {colorForNode, tagColor} from './Colors.js';
import {communityColor, detectCommunities, type CommunityResult} from './Communities.js';
import {el} from './Dom.js';
import type {EventKind} from './Events.js';
import type {GraphRenderer, GraphRendererCallbacks, GraphRendererState} from './GraphRenderer.js';
import {CONCENTRATE_COLOR, PULSE_COLORS, filterGraph} from './GraphRenderer.js';
import {resolvePositions, type PositionMap} from './GraphPositions.js';
import {edgeKinds, loadJsNGraph, readGraphTheme, type JsNGraph} from './GraphStyle.js';
import {normalizeHeat} from './Heat.js';
import {PersistentValue} from './Persistence.js';
import {SERVER_EDGE_KIND, ServerLayoutFeed, buildServerGraph, type ServerLayout} from './ServerLayout.js';
import {onThemeChange} from './Theme.js';

const STORAGE_POSITIONS = 'synaipse.graph.positions';
const positionsStore = new PersistentValue<PositionMap>(STORAGE_POSITIONS, {});

export type GraphState = GraphRendererState;
export type GraphCallbacks = GraphRendererCallbacks;

const HULL_PADDING = 24;
const HULL_MIN_NODES = 3;
const HEAT_COLOR = '#ffd166';

/**
 * Where node positions come from. `client`: saved arrangement, new notes
 * next to their neighbours, draggable. `server`: the precomputed Louvain
 * layout with one cluster disc per community when zoomed out.
 */
export type Placement = 'client' | 'server';

/** From this many notes the server layout is used. */
export const SERVER_LAYOUT_FROM = 3000;
/** Back to client placement only below this, so a vault at the limit does not flip on every write. */
export const CLIENT_LAYOUT_BELOW = 2500;
/** Server layout: below this zoom the communities are drawn instead of the notes. */
export const CLUSTER_ZOOM = 0.5;
/** Server layout: edges from this zoom on, labels from LABEL_ZOOM. */
const SERVER_EDGE_ZOOM = 1;
const SERVER_LABEL_ZOOM = 1.5;

export const choosePlacement = (noteCount: number, current: Placement | null): Placement => {
    if (current === 'server') {
        return noteCount < CLIENT_LAYOUT_BELOW ? 'client' : 'server';
    }

    return noteCount >= SERVER_LAYOUT_FROM ? 'server' : 'client';
};

interface BuiltGraph {
    nodes: NGraphNodeData[];
    edges: NGraphEdgeData[];
    hulls: NGraphHull[];
    communityCount: number;
}

/** Radius 7..16 by tag count, like the old cytoscape mapData(tagCount, 0, 5, 14, 32) diameter. */
export const nodeRadius = (tagCount: number): number => 7 + (Math.min(5, Math.max(0, tagCount)) / 5) * 9;

/**
 * The visible graph as jsNGraph data: filtered nodes coloured by community
 * or tag, stable edge ids (endpoints + kind, plus a counter for duplicates)
 * and one hull per tag with at least three visible notes.
 */
export const buildGraph = (state: GraphState, communities: CommunityResult | null): BuiltGraph => {
    const filtered = filterGraph(state);
    const useCommunity = state.showCommunities && communities !== null;
    const nodes: NGraphNodeData[] = filtered.nodes.map((n) => {
        const community = communities?.partition.get(n.id);

        return {
            id: n.id,
            label: n.title,
            shape: 'dot',
            color: useCommunity && community !== undefined ? communityColor(community) : colorForNode(n.tags),
            size: nodeRadius(n.tags.length)
        };
    });

    const seen = new Map<string, number>();
    const edges: NGraphEdgeData[] = filtered.edges.map((e) => {
        const key = `e:${e.kind}:${e.from}→${e.to}`;
        const n = seen.get(key) ?? 0;
        seen.set(key, n + 1);
        return {id: n === 0 ? key : `${key}#${n}`, source: e.from, target: e.to, kind: e.kind};
    });

    const hulls: NGraphHull[] = [];

    if (state.showHulls) {
        const byTag = new Map<string, string[]>();

        for (const n of filtered.nodes) {
            for (const tag of n.tags) {
                const ids = byTag.get(tag) ?? [];
                ids.push(n.id);
                byTag.set(tag, ids);
            }
        }

        for (const [tag, ids] of byTag) {
            if (ids.length >= HULL_MIN_NODES) {
                hulls.push({id: tag, nodeIds: ids, color: tagColor(tag), label: `${tag} · ${ids.length}`, padding: HULL_PADDING, opacity: 0.12});
            }
        }
    }

    return {nodes, edges, hulls, communityCount: communities?.count ?? 0};
};

/**
 * The 2D vault graph on jsNGraph, for every vault size (plan P6). Small
 * vaults use client placement (saved arrangement, draggable, tag hulls);
 * from SERVER_LAYOUT_FROM notes the server layout takes over and,
 * zoomed out, one disc per community replaces the notes (click to zoom
 * in). Size changes only the level of detail, not the view. Heat rings
 * and the live-activity effects are drawn by jsNGraph in both cases.
 */
export class GraphView implements GraphRenderer {
    public readonly element: HTMLElement;
    private state: GraphState;
    private readonly stage: HTMLElement;
    private readonly stats: HTMLElement;
    private graph: NGraph | null = null;
    private lib: JsNGraph | null = null;
    private placement: Placement | null = null;
    private destroyed = false;
    private heat: Map<string, number> = new Map();
    private notes = new Map<string, GraphData['nodes'][number]>();
    private unsubscribeTheme: (() => void) | null = null;

    // client placement
    private hullLabels: Map<string, string> = new Map();
    private hoveredNode = false;
    private cachedCommunities: {data: GraphData; result: CommunityResult} | null = null;

    // server placement
    private feed: ServerLayoutFeed | null = null;
    private layout: ServerLayout | null = null;
    private layoutMs = 0;
    /** Tooltip per cluster id. */
    private clusterTitles = new Map<string, string>();
    private fitted = false;

    public constructor(initial: GraphState, private readonly cb: GraphCallbacks) {
        this.state = initial;
        this.element = el('div', {class: 'graph-canvas'});
        this.stage = el('div', {class: 'graph'});
        this.stats = el('div', {class: 'graph-stats'});
        this.element.appendChild(this.stage);
        // After the stage: the canvas paints its own background.
        this.element.appendChild(this.stats);
    }

    /** Which placement is active (null before mount). */
    public get activePlacement(): Placement | null {
        return this.placement;
    }

    public mount(): void {
        void this.init();
    }

    public update(state: GraphState): void {
        const previous = this.state;
        this.state = state;
        if (this.graph === null) return;

        if (choosePlacement(state.data.nodes.length, this.placement) !== this.placement) {
            this.build();
            return;
        }

        if (this.placement === 'client') {
            this.renderClient();
            return;
        }

        if (state.data !== previous.data) {
            // Keep the viewport: only the positions are swapped in.
            void this.feed?.refresh(true);
            return;
        }

        if (state.showCommunities !== previous.showCommunities) {
            this.applyServerLayout();
            return;
        }

        this.applyFilter();
        this.graph.repaint();
    }

    public destroy(): void {
        this.destroyed = true;
        this.unsubscribeTheme?.();
        this.unsubscribeTheme = null;
        this.stage.removeEventListener('mousemove', this.onMouseMove);
        this.teardown();
        this.notes.clear();
    }

    public applyHeat(heatById: ReadonlyMap<string, number>): void {
        const heat = new Map<string, number>();

        for (const [id, raw] of heatById) {
            const h = normalizeHeat(raw);
            if (h > 0) heat.set(id, h);
        }

        this.heat = heat;
        this.graph?.repaint();
    }

    public pulse(noteIds: readonly string[], kind: EventKind): void {
        if (noteIds.length > 0) this.graph?.pulse(noteIds, PULSE_COLORS[kind], {durationMs: 1400});
    }

    public trail(fromId: string, toId: string, kind: EventKind): void {
        this.graph?.trail(fromId, toId, PULSE_COLORS[kind], {durationMs: 2200, curve: 28});
    }

    public concentrate(noteId: string): void {
        this.graph?.ripple(noteId, CONCENTRATE_COLOR, {waves: 2, delayMs: 220, durationMs: 1100, endRadius: 140});
    }

    public focus(_noteId: string): void {
        // Called on every live event; moving the 2D camera each time would
        // fight the user. Intentional no-op (the 3D view orbits instead).
    }

    private async init(): Promise<void> {
        const lib = await loadJsNGraph();

        if (this.destroyed) return;

        this.lib = lib;
        this.stage.addEventListener('mousemove', this.onMouseMove);
        this.unsubscribeTheme = onThemeChange(() => {
            if (this.graph !== null && this.lib !== null) this.graph.setTheme(readGraphTheme(this.lib, this.element));
        });

        this.build();
    }

    /**
     * (Re)create the jsNGraph instance for the placement the vault size
     * calls for. Its zoom limits and LOD options are fixed at construction,
     * so crossing the limit builds a new one (rare, see CLIENT_LAYOUT_BELOW).
     */
    private build(): void {
        const lib = this.lib;
        if (lib === null) return;

        this.teardown();
        const placement = choosePlacement(this.state.data.nodes.length, this.placement);
        this.placement = placement;

        const graph = new lib.NGraph(this.stage, {...this.commonOptions(lib), ...this.placementOptions(lib, placement)});
        this.graph = graph;

        graph.on('nodeClick', (node) => {
            if (node !== null) this.cb.onSelectNote(node.id);
        });
        graph.on('nodeHover', (node) => {
            this.hoveredNode = node !== null;
            if (this.hoveredNode) this.stage.title = '';
        });

        if (placement === 'client') {
            graph.on('nodeDragEnd', () => this.snapshotPositions());
            this.renderClient(true);
            return;
        }

        graph.on('clusterClick', (id) => this.graph?.focusCluster(id));
        graph.on('viewportChange', () => this.renderServerStats());
        this.stats.textContent = `computing layout for ${this.state.data.nodes.length} nodes / ${this.state.data.edges.length} edges…`;
        this.feed = new ServerLayoutFeed({
            onLayout: (layout, ms) => {
                this.layout = layout;
                this.layoutMs = ms;
                this.applyServerLayout();
            },
            onError: (cause) => {
                this.stats.textContent = `layout failed: ${String(cause)}`;
            }
        });
        void this.feed.refresh();
    }

    private teardown(): void {
        this.feed?.close();
        this.feed = null;
        this.layout = null;
        this.fitted = false;
        this.hullLabels = new Map();
        this.clusterTitles = new Map();
        this.hoveredNode = false;
        this.graph?.destroy();
        this.graph = null;
    }

    private commonOptions(lib: JsNGraph): NGraphOptions {
        return {
            theme: readGraphTheme(lib, this.element),
            layoutMode: 'static',
            panZoom: true,
            detailPanel: false,
            grid: false,
            lasso: false,
            tooltip: (node) => {
                const tags = this.notes.get(node.id)?.tags.slice(0, 3).join(', ') ?? '';
                return tags === '' ? node.label : `${node.label} · ${tags}`;
            },
            styleNode: (node) => {
                const h = this.state.showHeat ? this.heat.get(node.id) : undefined;
                if (h === undefined) return null;

                // Server-layout dots are smaller (3..7 vs 7..16 px), so is their ring.
                const width = this.placement === 'server' ? 1 + h * 3 : 1.5 + h * 4.5;
                return {ring: {color: HEAT_COLOR, width, opacity: 0.35 + h * 0.55}};
            }
        };
    }

    private placementOptions(lib: JsNGraph, placement: Placement): NGraphOptions {
        if (placement === 'client') {
            return {
                draggable: true,
                // cytoscape hid labels below ~7 px on screen at a 10 px font.
                labelMinZoom: 0.7,
                edgeKinds: {
                    ...edgeKinds(lib),
                    // Solid with an arrow; solid edges are also drawn batched.
                    wikilink: {tone: 'neutral', directed: true, animated: false},
                    tag: {tone: 'neutral', directed: true, animated: false}
                }
            };
        }

        return {
            draggable: false,
            minZoom: 0.01,
            maxZoom: 40,
            labelMinZoom: SERVER_LABEL_ZOOM,
            edgeMinZoom: SERVER_EDGE_ZOOM,
            clusterZoom: CLUSTER_ZOOM,
            edgeKinds: {[SERVER_EDGE_KIND]: {tone: 'neutral', width: 0.6, animated: false}}
        };
    }

    /** Native tooltip over a community disc (zoomed out) or a tag hull (not over a node). */
    private readonly onMouseMove = (event: MouseEvent): void => {
        const graph = this.graph;
        let title = '';

        if (graph !== null && !this.hoveredNode) {
            const rect = this.stage.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            const cluster = graph.isClustered() ? graph.clusterAt(x, y) : null;

            if (cluster !== null) {
                title = this.clusterTitles.get(cluster) ?? '';
            } else if (this.hullLabels.size > 0) {
                title = graph.hullsAt(x, y).map((id) => this.hullLabels.get(id) ?? id).join('\n');
            }
        }

        if (this.stage.title !== title) this.stage.title = title;
    };

    private getCommunities(): CommunityResult | null {
        if (!this.state.showCommunities) return null;

        if (this.cachedCommunities !== null && this.cachedCommunities.data === this.state.data) {
            return this.cachedCommunities.result;
        }

        const result = detectCommunities(this.state.data.nodes, this.state.data.edges);
        this.cachedCommunities = {data: this.state.data, result};
        return result;
    }

    /**
     * Client placement: bring the graph to the current state. Live positions
     * win over saved ones, so a write elsewhere does not move anything; new
     * notes are placed next to their neighbours. The camera and selection
     * stay (setData keeps both), only the first render fits the view.
     */
    private renderClient(first = false): void {
        const graph = this.graph;
        if (graph === null) return;

        this.notes = new Map(this.state.data.nodes.map((n) => [n.id, n]));
        const built = buildGraph(this.state, this.getCommunities());
        const statsParts = [`${built.nodes.length} nodes`, `${built.edges.length} edges`];

        if (this.state.showCommunities && built.communityCount > 0) {
            statsParts.push(`${built.communityCount} communities`);
        }

        this.stats.textContent = statsParts.join(' · ');

        const anchors: PositionMap = {...positionsStore.get(), ...graph.getPositions()};
        const positions = resolvePositions(built.nodes.map((n) => n.id), built.edges, anchors);

        for (const node of built.nodes) {
            const pos = positions.get(node.id);

            if (pos !== undefined) {
                node.x = pos.x;
                node.y = pos.y;
            }
        }

        graph.setData(built.nodes, built.edges);
        graph.setHulls(built.hulls);
        this.hullLabels = new Map(built.hulls.map((h) => [h.id, h.label ?? h.id]));

        if (first) {
            graph.fit({padding: 24});
            // Persist the placement of notes that had no saved position yet.
            this.snapshotPositions();
        }
    }

    private snapshotPositions(): void {
        if (this.graph === null || this.placement !== 'client') return;
        positionsStore.set({...positionsStore.get(), ...this.graph.getPositions()});
    }

    /** Server placement: push the cached layout into the graph; the camera stays, except for the first fit. */
    private applyServerLayout(): void {
        const graph = this.graph;
        const layout = this.layout;
        if (graph === null || layout === null) return;

        const built = buildServerGraph(layout, this.state.data, this.state.showCommunities);
        this.notes = new Map(this.state.data.nodes.map((n) => [n.id, n]));
        this.clusterTitles = new Map(built.clusters.map((c) => {
            const name = c.label ?? `community ${c.id}`;
            return [c.id, `${name} · ${c.size ?? 0} notes · click to zoom in`];
        }));

        graph.setData(built.nodes, built.edges);
        graph.setClusters(built.clusters, built.clusterEdges);
        this.applyFilter();

        if (!this.fitted) {
            graph.fit({padding: 24});
            this.fitted = true;
        }

        this.renderServerStats();
    }

    /** Server placement: tag filter and "hide isolated" through jsNGraph's filter (no data rebuild). */
    private applyFilter(): void {
        const graph = this.graph;
        if (graph === null) return;

        const filtered = filterGraph(this.state);

        if (filtered.visibleNodeCount === this.state.data.nodes.length) {
            graph.filter(null);
            return;
        }

        const visible = new Set(filtered.nodes.map((n) => n.id));
        graph.filter((node) => visible.has(node.id));
    }

    private renderServerStats(): void {
        const graph = this.graph;
        const layout = this.layout;
        if (graph === null || layout === null) return;

        const zoom = graph.getViewport().scale;
        const parts = graph.isClustered()
            ? [`overview · ${layout.communities.length} communities`, `mod ${layout.modularity.toFixed(2)}`, `zoom ${zoom.toFixed(2)}× (click a community)`]
            : [`${layout.nodes.length} nodes`, `${this.state.data.edges.length} edges`, `${layout.communities.length} communities`,
                `zoom ${zoom.toFixed(2)}×`];

        parts.push(`layout ${this.layoutMs}ms`);
        if (layout.stale === true) parts.push('updating…');

        this.stats.textContent = parts.join(' · ');
    }
}
