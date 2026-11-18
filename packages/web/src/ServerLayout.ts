import type {NGraphCluster, NGraphClusterEdge, NGraphEdgeData, NGraphNodeData} from 'jsngraph';
import type {Graph as GraphData} from '@synaipse/core';
import {api, type GraphLayout} from './Api.js';
import {colorForNode} from './Colors.js';
import {communityColor} from './Communities.js';

/** Edge kind of every server-layout edge: one solid neutral look, stroked in one batch. */
export const SERVER_EDGE_KIND = 'layout';
/** While the server still serves a stale layout, poll again after this delay. */
const STALE_POLL_MS = 1500;

export type ServerLayout = GraphLayout & {stale?: boolean};

export interface ServerGraphData {
    nodes: NGraphNodeData[];
    edges: NGraphEdgeData[];
    clusters: NGraphCluster[];
    clusterEdges: NGraphClusterEdge[];
}

/** Node radius in world px for the server layout: 3 plus up to 4 by degree. */
export const serverNodeRadius = (degree: number): number => 3 + Math.min(4, Math.sqrt(Math.max(0, degree)) * 0.5);

/**
 * The server layout as jsNGraph data: notes at their precomputed
 * positions (coloured by community or tag), edges between laid-out notes,
 * one cluster per community and the aggregated edges between them.
 * Layout entries without a note in `data` are skipped; notes the layout
 * does not know yet show up with the next layout.
 */
export const buildServerGraph = (layout: GraphLayout, data: GraphData, showCommunities: boolean): ServerGraphData => {
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
            size: serverNodeRadius(ln.degree),
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
            edges.push({id: `a${edges.length}`, source: e.from, target: e.to, kind: SERVER_EDGE_KIND});
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

export interface ServerLayoutFeedCallbacks {
    onLayout: (layout: ServerLayout, loadMs: number) => void;
    onError: (cause: unknown) => void;
}

/**
 * Fetches /api/graph/layout: one request at a time, a change during a
 * request queues one more, and a stale layout (the server is still
 * recomputing in the background) is polled until it is fresh.
 */
export class ServerLayoutFeed {
    private pending: Promise<void> | null = null;
    private queued = false;
    private staleTimer: number | null = null;
    private closed = false;

    public constructor(private readonly cb: ServerLayoutFeedCallbacks) {}

    /**
     * `force` skips the client cache: it only knows about writes from this
     * UI (not MCP or other tabs); an unchanged layout costs a 304.
     */
    public async refresh(force = false): Promise<void> {
        if (this.closed) return;

        if (this.pending !== null) {
            this.queued ||= force;
            return;
        }

        this.clearTimer();
        const started = Date.now();

        this.pending = (async () => {
            try {
                const layout = await api.getGraphLayout({force});
                if (this.closed) return;

                this.cb.onLayout(layout, Date.now() - started);

                if (layout.stale === true) {
                    this.staleTimer = window.setTimeout(() => {
                        this.staleTimer = null;
                        void this.refresh(true);
                    }, STALE_POLL_MS);
                }
            } catch (cause) {
                if (!this.closed) this.cb.onError(cause);
            } finally {
                this.pending = null;
            }

            if (this.queued && !this.closed) {
                this.queued = false;
                void this.refresh(true);
            }
        })();

        await this.pending;
    }

    public close(): void {
        this.closed = true;
        this.clearTimer();
    }

    private clearTimer(): void {
        if (this.staleTimer !== null) {
            window.clearTimeout(this.staleTimer);
            this.staleTimer = null;
        }
    }
}
