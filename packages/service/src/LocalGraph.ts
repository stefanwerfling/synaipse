import type {Graph, NoteId, TypedLinkKind} from '@synaipse/core';

export type LocalGraphEdgeKind = 'wikilink' | TypedLinkKind;

export interface LocalGraphNode {
    id: NoteId;
    title: string;
    /** Hops from the center (0 = the center itself). */
    hop: number;
    /** Wikilink degree in the whole vault — lets the UI size nodes by importance. */
    degree: number;
}

export interface LocalGraphEdge {
    from: NoteId;
    to: NoteId;
    kind: LocalGraphEdgeKind;
}

export interface LocalGraph {
    center: NoteId;
    nodes: LocalGraphNode[];
    edges: LocalGraphEdge[];
    /** True when the node limit cut the neighbourhood short. */
    truncated: boolean;
}

export interface LocalGraphOptions {
    /** Hops around the center, 1..3. Default 1. */
    depth?: number;
    /** Max nodes including the center. Default 60. */
    limit?: number;
}

/** Resolved typed frontmatter links of a note (`links: [{target, kind}]`). */
export type TypedLinkResolver = (id: NoteId) => ReadonlyArray<{to: NoteId; kind: TypedLinkKind}>;

const MAX_DEPTH = 3;
const MAX_LIMIT = 300;

/**
 * Ego network of `center` for the note viewer's local graph (plan P5/S1):
 * a BFS over body wikilinks (both directions) and the outgoing typed
 * frontmatter links of every visited note, bounded by depth and a node
 * limit so a hub note never ships half the vault.
 *
 * Within one hop, better-connected neighbours come first (ties by title),
 * so a truncated picture keeps the notes that matter most. Returns null
 * for an unknown center.
 */
export const buildLocalGraph = (
    graph: Graph,
    typedLinks: TypedLinkResolver,
    center: NoteId,
    options: LocalGraphOptions = {}
): LocalGraph | null => {
    const depth = Math.min(MAX_DEPTH, Math.max(1, Math.floor(options.depth ?? 1)));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(options.limit ?? 60)));
    const titles = new Map(graph.nodes.map((n) => [n.id, n.title]));

    if (!titles.has(center)) {
        return null;
    }

    const adjacency = new Map<NoteId, Set<NoteId>>();
    const link = (a: NoteId, b: NoteId): void => {
        if (a === b) return;
        let set = adjacency.get(a);
        if (set === undefined) adjacency.set(a, set = new Set());
        set.add(b);
    };

    for (const edge of graph.edges) {
        if (edge.kind !== 'wikilink') continue;
        link(edge.from, edge.to);
        link(edge.to, edge.from);
    }

    const degree = (id: NoteId): number => adjacency.get(id)?.size ?? 0;
    const typedCache = new Map<NoteId, ReadonlyArray<{to: NoteId; kind: TypedLinkKind}>>();
    const typedOf = (id: NoteId): ReadonlyArray<{to: NoteId; kind: TypedLinkKind}> => {
        let list = typedCache.get(id);
        if (list === undefined) {
            list = typedLinks(id).filter((t) => t.to !== id && titles.has(t.to));
            typedCache.set(id, list);
        }
        return list;
    };

    const hops = new Map<NoteId, number>([[center, 0]]);
    let frontier: NoteId[] = [center];
    let truncated = false;

    for (let hop = 1; hop <= depth && frontier.length > 0 && !truncated; hop++) {
        const candidates = new Set<NoteId>();

        for (const id of frontier) {
            for (const neighbour of adjacency.get(id) ?? []) {
                if (!hops.has(neighbour)) candidates.add(neighbour);
            }
            for (const typed of typedOf(id)) {
                if (!hops.has(typed.to)) candidates.add(typed.to);
            }
        }

        const ranked = [...candidates].sort((a, b) =>
            degree(b) - degree(a) || (titles.get(a) ?? a).localeCompare(titles.get(b) ?? b));
        const next: NoteId[] = [];

        for (const id of ranked) {
            if (hops.size >= limit) {
                truncated = true;
                break;
            }
            hops.set(id, hop);
            next.push(id);
        }

        frontier = next;
    }

    const edges: LocalGraphEdge[] = [];
    const seen = new Set<string>();
    const push = (from: NoteId, to: NoteId, kind: LocalGraphEdgeKind): void => {
        if (!hops.has(from) || !hops.has(to) || from === to) return;
        const key = `${from}\u0000${to}\u0000${kind}`;
        if (seen.has(key)) return;
        seen.add(key);
        edges.push({from, to, kind});
    };

    for (const edge of graph.edges) {
        if (edge.kind === 'wikilink') push(edge.from, edge.to, 'wikilink');
    }

    for (const id of hops.keys()) {
        for (const typed of typedOf(id)) push(id, typed.to, typed.kind);
    }

    return {
        center,
        nodes: [...hops].map(([id, hop]) => ({id, title: titles.get(id) ?? id, hop, degree: degree(id)})),
        edges,
        truncated
    };
};
