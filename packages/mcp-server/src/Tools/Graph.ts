import {extractTypedLinks} from '@synaipse/core';
import {isPathInScope, type SynaipseService} from '@synaipse/service';
import type {Graph} from '@synaipse/core';
import {resolveNoteId} from './Format.js';
import {asLimit, asString, enforceReadConsent, filterByConsent, ok, type ToolHandler} from './Shared.js';

const DIRECTIONS = ['in', 'out', 'both'] as const;
type Direction = typeof DIRECTIONS[number];

const asDirection = (value: unknown): Direction => {
    if (value === undefined || value === null) return 'both';
    if (typeof value === 'string' && (DIRECTIONS as readonly string[]).includes(value)) return value as Direction;
    throw new Error(`Invalid direction "${String(value)}" — expected one of: ${DIRECTIONS.join(', ')}`);
};

/**
 * Bounded neighbourhood of `center` over wikilink edges (undirected), BFS
 * up to `depth` hops, at most `limit` nodes. Without a center: the `limit`
 * best-connected notes. Never the whole vault — that does not fit into a
 * context window beyond toy sizes.
 */
const neighbourhood = (
    graph: Graph,
    center: string | null,
    depth: number,
    limit: number
): {nodes: Graph['nodes']; edges: Graph['edges']; truncated: boolean} => {
    const edges = graph.edges.filter((e) => e.kind === 'wikilink');
    const adjacency = new Map<string, Set<string>>();
    const link = (a: string, b: string): void => {
        let set = adjacency.get(a);
        if (set === undefined) adjacency.set(a, set = new Set());
        set.add(b);
    };
    for (const e of edges) {
        link(e.from, e.to);
        link(e.to, e.from);
    }

    let picked: string[];
    let truncated = false;
    if (center === null) {
        const ranked = graph.nodes
            .map((n) => n.id)
            .sort((a, b) => (adjacency.get(b)?.size ?? 0) - (adjacency.get(a)?.size ?? 0));
        truncated = ranked.length > limit;
        picked = ranked.slice(0, limit);
    } else {
        const seen = new Set([center]);
        let frontier = [center];
        for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
            const next: string[] = [];
            for (const id of frontier) {
                for (const neighbour of adjacency.get(id) ?? []) {
                    if (seen.has(neighbour)) continue;
                    if (seen.size >= limit) {
                        truncated = true;
                        break;
                    }
                    seen.add(neighbour);
                    next.push(neighbour);
                }
            }
            frontier = next;
        }
        picked = [...seen];
    }

    const keep = new Set(picked);
    return {
        nodes: graph.nodes.filter((n) => keep.has(n.id)),
        edges: edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
        truncated
    };
};

/** Link topology: links of a note, graph neighbourhood, link suggestions. */
export const graphTools = (service: SynaipseService): ToolHandler[] => [
    {
        definition: {
            name: 'synaipse_links',
            description: 'Links of a note. direction "in" = notes linking here (backlinks), "out" = wikilinks in the note (+ unresolved ones, + typed frontmatter links: supersedes/duplicates/relates_to/replies_to), "both" (default).',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {type: 'string', description: 'Vault path, title or alias'},
                    direction: {type: 'string', enum: [...DIRECTIONS]}
                },
                required: ['id']
            }
        },
        handle: async (args) => {
            const id = resolveNoteId(service, asString(args.id, 'id'));
            const direction = asDirection(args.direction);
            const result: Record<string, unknown> = {id};
            let touched = [id];

            if (direction !== 'out') {
                const filtered = filterByConsent(service, service.backlinks(id), (b) => b);
                result.in = filtered.items;
                if (filtered.skipped > 0) result.skippedByConsent = filtered.skipped;
                touched = [...touched, ...filtered.items.slice(0, 5)];
            }
            if (direction !== 'in') {
                const note = await enforceReadConsent(service, id);
                const unresolved = service.unresolvedWikilinks(note);
                const typed = extractTypedLinks(note.frontmatter);
                result.out = note.wikilinks;
                if (unresolved.length > 0) result.unresolved = unresolved;
                if (typed.length > 0) result.typed = typed;
            }

            return {response: ok(result), event: {kind: 'list', touched}};
        }
    },
    {
        definition: {
            name: 'synaipse_backlinks',
            description: 'Deprecated: use synaipse_links with direction "in".',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {type: 'string'}
                },
                required: ['id']
            }
        },
        handle: async (args) => {
            const id = asString(args.id, 'id');
            const backlinks = service.backlinks(id);
            const filtered = filterByConsent(service, backlinks, (b) => b);
            return {
                response: ok({
                    backlinks: filtered.items,
                    ...(filtered.skipped > 0 ? {skippedByConsent: filtered.skipped} : {})
                }),
                event: {kind: 'list', touched: [id, ...backlinks.slice(0, 5)]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_outgoing_links',
            description: 'Deprecated: use synaipse_links with direction "out".',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {type: 'string'}
                },
                required: ['id']
            }
        },
        handle: async (args) => {
            const id = asString(args.id, 'id');
            const note = await enforceReadConsent(service, id);
            const typed = extractTypedLinks(note.frontmatter);
            return {
                response: ok({wikilinks: note.wikilinks, typed}),
                event: {kind: 'list', touched: [id]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_graph',
            description: 'Wikilink graph around a note: nodes + edges within `depth` hops of `center`. Without center: the best-connected notes. Bounded by limit — never the whole vault.',
            inputSchema: {
                type: 'object',
                properties: {
                    center: {type: 'string', description: 'Vault path, title or alias'},
                    depth: {type: 'integer', minimum: 1, maximum: 3, description: 'Hops from center (default 1)'},
                    limit: {type: 'number', description: 'Max nodes (default 100)'}
                }
            }
        },
        handle: async (args) => {
            const center = typeof args.center === 'string' && args.center.length > 0
                ? resolveNoteId(service, args.center)
                : null;
            const depth = typeof args.depth === 'number' ? Math.min(3, Math.max(1, Math.trunc(args.depth))) : 1;
            const full = service.graph();
            const scoped: Graph = {
                nodes: full.nodes.filter((n) => isPathInScope(n.id)),
                edges: full.edges.filter((e) => isPathInScope(e.from) && isPathInScope(e.to))
            };
            const {nodes, edges, truncated} = neighbourhood(scoped, center, depth, asLimit(args.limit, 100));
            return {
                response: ok({
                    ...(center !== null ? {center, depth} : {}),
                    nodes: nodes.map((n) => ({id: n.id, title: n.title})),
                    edges: edges.map((e) => [e.from, e.to]),
                    ...(truncated ? {truncated: true, totalNodes: scoped.nodes.length} : {})
                }),
                event: {kind: 'graph', touched: center !== null ? [center] : []}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_suggest_links',
            description: 'Note pairs that look related (semantic similarity or ≥2 shared tags) but are not linked — materialise with synaipse_link_note.',
            inputSchema: {
                type: 'object',
                properties: {
                    limit: {type: 'number', description: 'Default 20'},
                    minScore: {type: 'number', description: 'Semantic threshold 0-1 (default 0.65)'},
                    pathPrefix: {type: 'string', description: 'Folder'}
                }
            }
        },
        handle: async (args) => {
            const limit = asLimit(args.limit, 20);
            const minScore = typeof args.minScore === 'number' ? args.minScore : 0.65;
            const pathPrefix = typeof args.pathPrefix === 'string' ? args.pathPrefix : '';
            const suggestions = (await service.suggestLinks({limit, minScore, pathPrefix}))
                .filter((s) => isPathInScope(s.a) && isPathInScope(s.b));
            return {
                response: ok({suggestions, count: suggestions.length}),
                event: {
                    kind: 'search',
                    touched: [...new Set(suggestions.slice(0, 5).flatMap((s) => [s.a, s.b]))]
                }
            };
        }
    }
];
