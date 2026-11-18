import {isPathInScope, type SynaipseService} from '@synaipse/service';
import {ageOf, modifiedOf} from './Format.js';
import {asLimit, asSearchMode, asString, filterByConsent, filterNotesByConsent, ok, type ToolHandler} from './Shared.js';

/** Retrieval, listing and the session primer. */
export const searchTools = (service: SynaipseService): ToolHandler[] => [
    {
        definition: {
            name: 'synaipse_search',
            description: 'Search the Synaipse knowledge base. Modes: fulltext (keywords), semantic (meaning), hybrid (both). Use semantic for concept questions, fulltext for exact terms, hybrid by default. Pass explain:true to receive a per-signal score breakdown for each hit — useful when ranking is surprising.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: {type: 'string', description: 'Search query'},
                    mode: {type: 'string', enum: ['fulltext', 'semantic', 'hybrid'], description: 'Search strategy (default: hybrid)'},
                    limit: {type: 'number', description: 'Max results (default: 10)'},
                    explain: {type: 'boolean', description: 'Include per-signal components ({score, rank} per fulltext/title/semantic/graph + demote multiplier) on each hit. Default false to keep responses compact.'}
                },
                required: ['query']
            }
        },
        handle: async (args) => {
            const query = asString(args.query, 'query');
            const explain = args.explain === true;
            const raw = await service.search(query, asSearchMode(args.mode), asLimit(args.limit, 10));
            // Brief hits: `path` duplicates noteId and chunkId is internal;
            // both (and the score breakdown) only come back with explain.
            const stripped = explain
                ? raw
                : raw.map(({components: _c, path: _p, chunkId: _id, score, ...rest}) => ({...rest, score: Math.round(score * 1000) / 1000}));
            const filtered = filterByConsent(service, stripped, (h) => h.noteId);
            return {
                response: ok({
                    hits: filtered.items,
                    ...(filtered.skipped > 0 ? {skippedByConsent: filtered.skipped} : {})
                }),
                event: {kind: 'search', touched: filtered.items.slice(0, 5).map((h) => h.noteId), query}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_list_notes',
            description: 'List notes in the vault (id, title, tags, modified, age). Useful for browsing or building a sitemap.',
            inputSchema: {
                type: 'object',
                properties: {
                    pathPrefix: {type: 'string', description: 'Filter by path prefix, e.g. "Memory/decisions/"'},
                    limit: {type: 'number'}
                }
            }
        },
        handle: async (args) => {
            const prefix = typeof args.pathPrefix === 'string' ? args.pathPrefix : '';
            const limit = asLimit(args.limit, 200);

            const raw = service.listNotes().filter((n) => n.id.startsWith(prefix));
            const filtered = filterNotesByConsent(raw);
            const notes = filtered.items
                .slice(0, limit)
                .map((n) => ({id: n.id, title: n.title, tags: n.tags, ...modifiedOf(n.mtime)}));

            return {
                response: ok({
                    notes,
                    ...(filtered.skipped > 0 ? {skippedByConsent: filtered.skipped} : {})
                }),
                event: {kind: 'list', touched: []}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_list_tags',
            description: 'List all tags in the vault with note counts.',
            inputSchema: {type: 'object', properties: {}}
        },
        handle: async () => {
            const tags = [...service.tags().entries()]
                .map(([tag, ids]) => ({tag, count: ids.filter(isPathInScope).length}))
                .filter((t) => t.count > 0)
                .sort((a, b) => b.count - a.count);
            return {response: ok({tags}), event: {kind: 'tags', touched: []}};
        }
    },
    {
        definition: {
            name: 'synaipse_notes_by_tag',
            description: 'Return all notes that carry a given tag.',
            inputSchema: {
                type: 'object',
                properties: {
                    tag: {type: 'string'}
                },
                required: ['tag']
            }
        },
        handle: async (args) => {
            const tag = asString(args.tag, 'tag');
            const ids = service.tags().get(tag) ?? [];
            const raw = ids
                .map((id) => service.tryReadNote(id))
                .filter((n): n is NonNullable<typeof n> => n !== undefined);
            const filtered = filterNotesByConsent(raw);
            const notes = filtered.items.map((n) => ({id: n.id, title: n.title, tags: n.tags}));
            return {
                response: ok({
                    notes,
                    ...(filtered.skipped > 0 ? {skippedByConsent: filtered.skipped} : {})
                }),
                event: {kind: 'list', touched: ids.slice(0, 10)}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_recent',
            description: 'Return the N most recently modified notes.',
            inputSchema: {
                type: 'object',
                properties: {
                    limit: {type: 'number'}
                }
            }
        },
        handle: async (args) => {
            const limit = asLimit(args.limit, 20);
            const sorted = [...service.listNotes()]
                .sort((a, b) => b.mtime - a.mtime);
            const filtered = filterNotesByConsent(sorted);
            const notes = filtered.items
                .slice(0, limit)
                .map((n) => ({id: n.id, title: n.title, ...modifiedOf(n.mtime)}));
            return {
                response: ok({
                    notes,
                    ...(filtered.skipped > 0 ? {skippedByConsent: filtered.skipped} : {})
                }),
                event: {kind: 'list', touched: notes.slice(0, 5).map((n) => n.id)}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_prime',
            description: 'Return a curated context bundle for the current project: pinned notes, recent sessions, project decisions, topic-relevant notes (when topic is given), referenced notes (explicitly cited via synaipse_log_session in past sessions — real evidence of usefulness, ranked above hot), hot notes (by backlink count), and recently-edited notes — plus a TODO digest. Each entry carries a "reason" tag so you can prioritise. Crawler/ content (external imports — GitHub stars, dev.to articles) is excluded from referenced/hot/recent/todos by default; pass includeCrawler:true to include it. Topic search always includes Crawler/ — if you ask for a topic, you want hits. Call this once at session start (or when switching context) to prime yourself with what matters most before doing anything else.',
            inputSchema: {
                type: 'object',
                properties: {
                    limit: {type: 'number', description: 'Max entries in the context list (default: 15). Pinned notes always count toward the limit but are added first.'},
                    topic: {type: 'string', description: 'Optional query to bias selection — adds up to 5 topic-relevant notes via hybrid search, prioritised above hot/recent. Topic always includes Crawler/ hits.'},
                    includeCrawler: {type: 'boolean', description: 'Include crawler-imported notes (Crawler/**) in hot/recent/todos. Default false — these tend to dominate (large indexes, third-party TODOs). Does not affect topic search, which always considers Crawler/.'}
                }
            }
        },
        handle: async (args, ctx) => {
            const limit = asLimit(args.limit, 15);
            const topic = typeof args.topic === 'string' ? args.topic : '';
            const includeCrawler = args.includeCrawler === true;
            const result = await service.prime({project: ctx?.project ?? null, limit, topic, includeCrawler});
            const filteredCtx = filterByConsent(service, result.context, (e) => e.id);
            const filteredTodos = filterByConsent(service, result.todoSample, (t) => t.noteId);
            const skipped = filteredCtx.skipped + filteredTodos.skipped;
            const primed = {
                ...result,
                // Relative age is all a primer needs and costs ~2 tokens.
                context: filteredCtx.items.map(({mtime, ...rest}) => ({...rest, age: ageOf(mtime)})),
                todoSample: filteredTodos.items,
                ...(skipped > 0 ? {skippedByConsent: skipped} : {})
            };
            return {
                response: ok(primed),
                event: {kind: 'list', touched: primed.context.slice(0, 5).map((e) => e.id)}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_related',
            description: 'Find notes related to a given note via semantic similarity, wikilinks (in & out), and shared tags. Returns ranked list with reasons.',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {type: 'string', description: 'Note id (relative path) to find related notes for'},
                    limit: {type: 'number', description: 'Max results (default: 10)'}
                },
                required: ['id']
            }
        },
        handle: async (args) => {
            const id = asString(args.id, 'id');
            const raw = await service.related(id, asLimit(args.limit, 10));
            const filtered = filterByConsent(service, raw, (r) => r.id);
            return {
                response: ok({
                    related: filtered.items,
                    ...(filtered.skipped > 0 ? {skippedByConsent: filtered.skipped} : {})
                }),
                event: {kind: 'search', touched: [id, ...filtered.items.slice(0, 5).map((r) => r.id)]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_todos',
            description: 'Collect open todos (- [ ]) across the vault. Optionally filter by path prefix or include completed items.',
            inputSchema: {
                type: 'object',
                properties: {
                    pathPrefix: {type: 'string', description: 'Filter by note path prefix, e.g. "Memory/projects/"'},
                    includeDone: {type: 'boolean', description: 'Include completed - [x] items (default: false)'}
                }
            }
        },
        handle: async (args) => {
            const prefix = typeof args.pathPrefix === 'string' ? args.pathPrefix : '';
            const includeDone = args.includeDone === true;
            const raw = service.todos(prefix, includeDone);
            const filtered = filterByConsent(service, raw, (t) => t.noteId);
            return {
                response: ok({
                    todos: filtered.items,
                    count: filtered.items.length,
                    ...(filtered.skipped > 0 ? {skippedByConsent: filtered.skipped} : {})
                }),
                event: {kind: 'list', touched: [...new Set(filtered.items.slice(0, 10).map((t) => t.noteId))]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_stale',
            description: 'List notes that have not been written or surfaced (read/searched/related/backlinks) for a long time. Use to find knowledge gathering dust — candidates for review, refresh, or deletion.',
            inputSchema: {
                type: 'object',
                properties: {
                    olderThanDays: {type: 'number', description: 'Threshold in days (default: 90). A note is stale when max(mtime, lastAccessed, lastReferenced) is older than this — lastReferenced tracks explicit citations via synaipse_log_session, distinct from mere retrieval.'},
                    pathPrefix: {type: 'string', description: 'Restrict to a folder, e.g. "Memory/research/"'},
                    limit: {type: 'number', description: 'Max results (default: 100)'}
                }
            }
        },
        handle: async (args) => {
            const olderThanDays = typeof args.olderThanDays === 'number' ? args.olderThanDays : 90;
            const pathPrefix = typeof args.pathPrefix === 'string' ? args.pathPrefix : '';
            const limit = asLimit(args.limit, 100);
            const raw = service.staleNotes({olderThanDays, pathPrefix, limit});
            const filtered = filterByConsent(service, raw, (n) => n.id);
            return {
                response: ok({
                    notes: filtered.items.map(({mtime: _m, lastAccessed, lastReferenced, ...rest}) => ({
                        ...rest,
                        ...(lastAccessed !== undefined ? {lastAccessed: ageOf(lastAccessed)} : {}),
                        ...(lastReferenced !== undefined ? {lastReferenced: ageOf(lastReferenced)} : {})
                    })),
                    count: filtered.items.length,
                    olderThanDays,
                    ...(filtered.skipped > 0 ? {skippedByConsent: filtered.skipped} : {})
                }),
                event: {kind: 'list', touched: filtered.items.slice(0, 5).map((n) => n.id)}
            };
        }
    }
];
