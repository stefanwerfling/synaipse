import {extractTypedLinks} from '@synaipse/core';
import {isPathInScope, type SynaipseService} from '@synaipse/service';
import {asLimit, asString, enforceReadConsent, filterByConsent, ok, type ToolHandler} from './Shared.js';

/** Link topology: backlinks, outgoing links, graph, link suggestions. */
export const graphTools = (service: SynaipseService): ToolHandler[] => [
    {
        definition: {
            name: 'synaipse_backlinks',
            description: 'List notes that link to the given note via wikilinks.',
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
            description: 'List wikilinks contained in the given note. Returns body wikilinks (`[[Target]]` in markdown, resolved + unresolved) and, when present, typed links declared in frontmatter under `links:` (each `{target, kind}` where kind ∈ supersedes|duplicates|relates_to|replies_to). Typed links carry explicit semantics for cross-reference reasoning; body wikilinks still drive search/graph topology.',
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
            description: 'Return the knowledge graph (nodes + wikilink edges). Use for visualisation or structural reasoning.',
            inputSchema: {type: 'object', properties: {}}
        },
        handle: async () => {
            const full = service.graph();
            const graph = {
                nodes: full.nodes.filter((n) => isPathInScope(n.id)),
                edges: full.edges.filter((e) => isPathInScope(e.from) && isPathInScope(e.to))
            };
            return {response: ok({graph}), event: {kind: 'graph', touched: []}};
        }
    },
    {
        definition: {
            name: 'synaipse_suggest_links',
            description: 'Find pairs of notes that look related (semantic similarity or ≥2 shared tags) but have no wikilink between them. Returns ranked suggestions you can materialise with synaipse_link_note. Without an embeddings provider, only tag-overlap suggestions are returned.',
            inputSchema: {
                type: 'object',
                properties: {
                    limit: {type: 'number', description: 'Max suggestions (default: 20)'},
                    minScore: {type: 'number', description: 'Minimum semantic similarity in [0,1] (default: 0.65). Tag-overlap suggestions are not filtered by this.'},
                    pathPrefix: {type: 'string', description: 'Restrict scan to a folder, e.g. "Memory/decisions/"'}
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
