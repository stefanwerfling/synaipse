import type {NGraph, NGraphCluster, NGraphClusterEdge, NGraphEdgeData, NGraphNodeData} from 'jsngraph';
import type {Graph as GraphData} from '@synaipse/core';
import {api, type GraphLayout} from './Api.js';
import {colorForNode} from './Colors.js';
import {communityColor} from './Communities.js';
import {el} from './Dom.js';
import type {EventKind} from './Events.js';
import type {GraphRenderer, GraphRendererCallbacks, GraphRendererState} from './GraphRenderer.js';
import {CONCENTRATE_COLOR, PULSE_COLORS, filterGraph} from './GraphRenderer.js';
import {loadJsNGraph, readGraphTheme, type JsNGraph} from './GraphStyle.js';
import {normalizeHeat} from './Heat.js';
import {onThemeChange} from './Theme.js';

/** Below this zoom the communities are drawn instead of the notes. */
export const ATLAS_CLUSTER_ZOOM = 0.5;
/** Edges show from this zoom on, labels from LABEL_ZOOM (as in the old canvas atlas). */
const EDGE_ZOOM = 1;
const LABEL_ZOOM = 1.5;
const HEAT_COLOR = '#ffd166';
/** Edge kind of every atlas edge: one solid neutral look, stroked in one batch. */
const ATLAS_EDGE = 'atlas';
/** While the server still serves a stale layout, poll again after this delay. */
const STALE_POLL_MS = 1500;

export interface AtlasData {
    nodes: NGraphNodeData[];
    edges: NGraphEdgeData[];
    clusters: NGraphCluster[];
    clusterEdges: NGraphClusterEdge[];
}

/** Node radius in world px: 3 plus up to 4 by degree. */
export const atlasNodeRadius = (degree: number): number => 3 + Math.min(4, Math.sqrt(Math.max(0, degree)) * 0.5);

/**
 * The server layout as jsNGraph data: notes at their precomputed
 * positions (coloured by community or tag), edges between laid-out notes,
 * one cluster per community and the aggregated edges between them.
 * Layout entries without a note in `data` are skipped.
 */
export const buildAtlas = (layout: GraphLayout, data: GraphData, showCommunities: boolean): AtlasData => {
    const notes = new Map(data.nodes.map((n) => [n.id, n]));
    const members = new Map<number, string[]>();
    const nodes: NGraphNodeData[] = [];

    for (const ln of layout.nodes) {
        const note = notes.get(ln.id);

        if (note === undefined) {
            continue;
        }

        nodes.push({
            id: ln.id,
            label: note.title,
            shape: 'dot',
            color: showCommunities ? communityColor(ln.community) : colorForNode(note.tags),
            size: atlasNodeRadius(ln.degree),
            x: ln.x,
            y: ln.y
        });

        const ids = members.get(ln.community) ?? [];
        ids.push(ln.id);
        members.set(ln.community, ids);
    }

    const placed = new Set(nodes.map((n) => n.id));
    const edges: NGraphEdgeData[] = [];

    for (const e of data.edges) {
        if (placed.has(e.from) && placed.has(e.to) && e.from !== e.to) {
            edges.push({id: `a${edges.length}`, source: e.from, target: e.to, kind: ATLAS_EDGE});
        }
    }

    const clusters: NGraphCluster[] = layout.communities.map((c) => ({
        id: String(c.id),
        x: c.cx,
        y: c.cy,
        size: c.size,
        radius: c.radius,
        color: communityColor(c.id),
        nodeIds: members.get(c.id) ?? []
    }));

    const clusterEdges: NGraphClusterEdge[] = layout.interCommunityEdges.map((e) => ({
        source: String(e.from),
        target: String(e.to),
        weight: e.weight
    }));

    return {nodes, edges, clusters, clusterEdges};
};

/**
 * Atlas view (plan P6 / S3): the server-precomputed Louvain layout on
 * jsNGraph, for vaults too big for the interactive views. Zoomed out it
 * shows one disc per community (click to zoom in), then the notes, edges
 * from EDGE_ZOOM and labels from LABEL_ZOOM. Culling, batching and the
 * cluster overview come from jsNGraph; this class only maps data.
 */
export class GraphAtlasView implements GraphRenderer {
    public readonly element: HTMLElement;
    private state: GraphRendererState;
    private readonly stage: HTMLElement;
    private readonly stats: HTMLElement;
    private graph: NGraph | null = null;
    private lib: JsNGraph | null = null;
    private layout: (GraphLayout & {stale?: boolean}) | null = null;
    private notes = new Map<string, GraphData['nodes'][number]>();
    private communitySizes = new Map<string, number>();
    private heat: Map<string, number> = new Map();
    private pendingFetch: Promise<void> | null = null;
    /** A data change arrived during a fetch: fetch again once it is done. */
    private refetchQueued = false;
    private staleTimer: number | null = null;
    private destroyed = false;
    private fitted = false;
    private loadMs = 0;
    private unsubscribeTheme: (() => void) | null = null;

    public constructor(initial: GraphRendererState, private readonly cb: GraphRendererCallbacks) {
        this.state = initial;
        this.element = el('div', {class: 'graph-canvas atlas'});
        this.stage = el('div', {class: 'graph'});
        this.stats = el('div', {class: 'graph-stats'});
        this.element.appendChild(this.stage);
        this.element.appendChild(this.stats);
    }

    public mount(): void {
        void this.init();
    }

    public update(state: GraphRendererState): void {
        const previous = this.state;
        this.state = state;

        if (state.data !== previous.data) {
            // Keep the viewport: only the positions are swapped in. Forced,
            // because the client cache only knows about writes from this UI
            // (not MCP or other tabs); an unchanged layout costs a 304.
            void this.refreshLayout(true);
            return;
        }

        if (state.showCommunities !== previous.showCommunities) {
            this.applyLayout();
            return;
        }

        this.applyFilter();
        this.graph?.repaint();
    }

    public destroy(): void {
        this.destroyed = true;

        if (this.staleTimer !== null) {
            window.clearTimeout(this.staleTimer);
            this.staleTimer = null;
        }

        this.unsubscribeTheme?.();
        this.unsubscribeTheme = null;
        this.stage.removeEventListener('mousemove', this.onMouseMove);
        this.graph?.destroy();
        this.graph = null;
        this.layout = null;
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
        // Called on every live event; moving the camera each time would fight
        // the user (same as the 2D view).
    }

    private async init(): Promise<void> {
        const lib = await loadJsNGraph();

        if (this.destroyed) return;

        this.lib = lib;
        this.graph = new lib.NGraph(this.stage, {
            theme: readGraphTheme(lib, this.element),
            layoutMode: 'static',
            panZoom: true,
            detailPanel: false,
            draggable: false,
            lasso: false,
            grid: false,
            minZoom: 0.01,
            maxZoom: 40,
            labelMinZoom: LABEL_ZOOM,
            edgeMinZoom: EDGE_ZOOM,
            clusterZoom: ATLAS_CLUSTER_ZOOM,
            edgeKinds: {[ATLAS_EDGE]: {tone: 'neutral', width: 0.6, animated: false}},
            tooltip: (node) => {
                const note = this.notes.get(node.id);
                const tags = note?.tags.slice(0, 3).join(', ') ?? '';
                return tags === '' ? node.label : `${node.label} · ${tags}`;
            },
            styleNode: (node) => {
                const h = this.state.showHeat ? this.heat.get(node.id) : undefined;
                return h === undefined ? null : {ring: {color: HEAT_COLOR, width: 1 + h * 3, opacity: 0.35 + h * 0.55}};
            }
        });

        this.graph.on('nodeClick', (node) => {
            if (node !== null) this.cb.onSelectNote(node.id);
        });
        this.graph.on('clusterClick', (id) => this.graph?.focusCluster(id));
        this.graph.on('viewportChange', () => this.renderStats());
        this.stage.addEventListener('mousemove', this.onMouseMove);
        this.unsubscribeTheme = onThemeChange(() => {
            if (this.graph !== null && this.lib !== null) this.graph.setTheme(readGraphTheme(this.lib, this.element));
        });

        await this.refreshLayout();
    }

    /** Community size as a native tooltip over a cluster disc. */
    private readonly onMouseMove = (event: MouseEvent): void => {
        const graph = this.graph;
        if (graph === null) return;

        const rect = this.stage.getBoundingClientRect();
        const id = graph.clusterAt(event.clientX - rect.left, event.clientY - rect.top);
        const title = id === null ? '' : `community ${id} · ${this.communitySizes.get(id) ?? 0} notes · click to zoom in`;

        if (this.stage.title !== title) this.stage.title = title;
    };

    private async refreshLayout(force = false): Promise<void> {
        if (this.graph === null) return;

        if (this.pendingFetch !== null) {
            this.refetchQueued ||= force;
            return;
        }

        if (this.staleTimer !== null) {
            window.clearTimeout(this.staleTimer);
            this.staleTimer = null;
        }

        const started = Date.now();
        if (this.layout === null) this.stats.textContent = `computing layout for ${this.state.data.nodes.length} nodes / ${this.state.data.edges.length} edges…`;

        this.pendingFetch = (async () => {
            try {
                const layout = await api.getGraphLayout({force});
                if (this.destroyed) return;

                this.layout = layout;
                this.loadMs = Date.now() - started;
                this.applyLayout();

                if (layout.stale === true) {
                    this.staleTimer = window.setTimeout(() => {
                        this.staleTimer = null;
                        void this.refreshLayout(true);
                    }, STALE_POLL_MS);
                }
            } catch (cause) {
                this.stats.textContent = `layout failed: ${String(cause)}`;
            } finally {
                this.pendingFetch = null;
            }

            if (this.refetchQueued && !this.destroyed) {
                this.refetchQueued = false;
                void this.refreshLayout(true);
            }
        })();

        await this.pendingFetch;
    }

    /** Push the cached layout into the graph; the camera stays, except for the first fit. */
    private applyLayout(): void {
        const graph = this.graph;
        const layout = this.layout;
        if (graph === null || layout === null) return;

        const atlas = buildAtlas(layout, this.state.data, this.state.showCommunities);
        this.notes = new Map(this.state.data.nodes.map((n) => [n.id, n]));
        this.communitySizes = new Map(atlas.clusters.map((c) => [c.id, c.size ?? 0]));

        graph.setData(atlas.nodes, atlas.edges);
        graph.setClusters(atlas.clusters, atlas.clusterEdges);
        this.applyFilter();

        if (!this.fitted) {
            graph.fit({padding: 24});
            this.fitted = true;
        }

        this.renderStats();
    }

    /** Tag filter and "hide isolated" through jsNGraph's filter (no data rebuild). */
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

    private renderStats(): void {
        const graph = this.graph;
        const layout = this.layout;
        if (graph === null || layout === null) return;

        const zoom = graph.getViewport().scale;
        const parts = graph.isClustered()
            ? [`overview · ${layout.communities.length} communities`, `mod ${layout.modularity.toFixed(2)}`, `zoom ${zoom.toFixed(2)}× (click a community)`]
            : [`${layout.nodes.length} nodes`, `${this.state.data.edges.length} edges`, `${layout.communities.length} communities`,
                `zoom ${zoom.toFixed(2)}×`];

        parts.push(`${this.loadMs}ms`);
        if (layout.stale === true) parts.push('updating…');

        this.stats.textContent = parts.join(' · ');
    }
}
