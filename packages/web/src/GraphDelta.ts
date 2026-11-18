import type {Graph, GraphEdge, GraphNode} from '@synaipse/core';
import type {NoteSummary} from './Api.js';

/**
 * Client half of the graph deltas (plan P4 / A5); the server half is
 * `server/graph-deltas.ts`. A delta moves the note list and the graph
 * from version `from` to `to`. It applies only to state at exactly
 * `from`; anything else means events were missed and the caller
 * re-fetches.
 */
export interface GraphDelta {
    from: number;
    to: number;
    nodes: {upsert: GraphNode[]; removed: string[]};
    edges: {added: GraphEdge[]; removed: GraphEdge[]};
    notes: {upsert: NoteSummary[]; removed: string[]};
}

export interface GraphReset {
    to: number;
}

/** Response header carrying the version a `/api/notes` or `/api/graph` body was built at. */
export const VERSION_HEADER = 'X-Synaipse-Version';

export const parseVersion = (value: string | null): number | null => {
    if (value === null) return null;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
};

const edgeKey = (e: GraphEdge): string => `${e.from}\u0000${e.to}\u0000${e.kind}`;

/** New graph object with the delta applied; the input is not modified. */
export const applyGraphDelta = (graph: Graph, delta: GraphDelta): Graph => {
    const removedNodes = new Set(delta.nodes.removed);
    const upserts = new Map(delta.nodes.upsert.map((n) => [n.id, n]));

    const nodes: GraphNode[] = [];
    for (const node of graph.nodes) {
        if (removedNodes.has(node.id)) continue;
        const replacement = upserts.get(node.id);
        if (replacement !== undefined) {
            nodes.push(replacement);
            upserts.delete(node.id);
        } else {
            nodes.push(node);
        }
    }
    nodes.push(...upserts.values());

    const removedEdges = new Set(delta.edges.removed.map(edgeKey));
    const seen = new Set<string>();
    const edges: GraphEdge[] = [];
    for (const edge of [...graph.edges, ...delta.edges.added]) {
        const key = edgeKey(edge);
        if (removedEdges.has(key) || seen.has(key)) continue;
        if (removedNodes.has(edge.from) || removedNodes.has(edge.to)) continue;
        seen.add(key);
        edges.push(edge);
    }

    return {nodes, edges};
};

/** New note list with the delta applied, order kept, new notes appended. */
export const applyNotesDelta = (notes: readonly NoteSummary[], delta: GraphDelta): NoteSummary[] => {
    const removed = new Set(delta.notes.removed);
    const upserts = new Map(delta.notes.upsert.map((n) => [n.id, n]));
    const out: NoteSummary[] = [];

    for (const note of notes) {
        if (removed.has(note.id)) continue;
        const replacement = upserts.get(note.id);
        if (replacement !== undefined) {
            out.push(replacement);
            upserts.delete(note.id);
        } else {
            out.push(note);
        }
    }
    out.push(...upserts.values());

    return out;
};

export const isEmptyGraphDelta = (delta: GraphDelta): boolean =>
    delta.nodes.upsert.length === 0 && delta.nodes.removed.length === 0
    && delta.edges.added.length === 0 && delta.edges.removed.length === 0;
