import {isPathInScope, type SynaipseService} from '@synaipse/service';
import {ageOf, modifiedOf} from './Format.js';
import {asLimit, asSearchMode, asString, filterByConsent, filterNotesByConsent, ok, type ToolHandler} from './Shared.js';

/** Retrieval, listing and the session primer. */
export const searchTools = (service: SynaipseService): ToolHandler[] => [
    {
        definition: {
            name: 'synaipse_list',
            description: 'List notes (id, title, tags, modified, age), newest first or by title. Filter by folder prefix and/or tag; page with cursor.',
            inputSchema: {
                type: 'object',
                properties: {
                    prefix: {type: 'string', description: 'Folder prefix, e.g. "Memory/decisions/"'},
                    tag: {type: 'string'},
                    sort: {type: 'string', enum: ['modified', 'title'], description: 'Default modified (newest first)'},
                    limit: {type: 'number', description: 'Default 50'},
                    cursor: {type: 'string', description: 'nextCursor from the previous page'}
                }
            }
        },
        handle: async (args) => {
            const prefix = typeof args.prefix === 'string' ? args.prefix : '';
            const sort = args.sort === undefined || args.sort === null ? 'modified' : args.sort;
            if (sort !== 'modified' && sort !== 'title') {
                throw new Error(`Invalid sort "${String(sort)}" — expected one of: modified, title`);
            }
            const limit = asLimit(args.limit, 50);
            const offset = typeof args.cursor === 'string' && /^\d+$/.test(args.cursor) ? Number(args.cursor) : 0;

            let candidates = service.listNotes().filter((n) => n.id.startsWith(prefix));
            if (typeof args.tag === 'string' && args.tag.length > 0) {
                const tagged = new Set(service.tags().get(args.tag) ?? []);
                candidates = candidates.filter((n) => tagged.has(n.id));
            }
            const filtered = filterNotesByConsent(candidates);
            const sorted = sort === 'title'
                ? [...filtered.items].sort((a, b) => a.title.localeCompare(b.title))
                : [...filtered.items].sort((a, b) => b.mtime - a.mtime);
            const page = sorted.slice(offset, offset + limit);

            return {
                response: ok({
                    notes: page.map((n) => ({id: n.id, title: n.title, tags: n.tags, ...modifiedOf(n.mtime)})),
                    total: sorted.length,
                    ...(offset + limit < sorted.length ? {nextCursor: String(offset + limit)} : {}),
                    ...(filtered.skipped > 0 ? {skippedByConsent: filtered.skipped} : {})
                }),
                event: {kind: 'list', touched: page.slice(0, 5).map((n) => n.id)}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_search',
            description: 'Search the vault. mode: hybrid (default), fulltext (exact terms) or semantic (concepts). explain:true adds a per-signal score breakdown.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: {type: 'string'},
                    mode: {type: 'string', enum: ['fulltext', 'semantic', 'hybrid']},
                    limit: {type: 'number', description: 'Default 10'},
                    explain: {type: 'boolean'}
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
            description: 'Deprecated: use synaipse_list.',
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
            description: 'Deprecated: use synaipse_list with tag.',
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
            description: 'Deprecated: use synaipse_list (sorted by modified by default).',
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
            description: 'Context bundle for the active project — call once at session start or when switching topic: pinned notes, recent sessions, decisions, topic hits, notes cited in past sessions, hot and recent notes, plus a TODO digest; each entry has a reason. Crawler/ imports are excluded unless includeCrawler.',
            inputSchema: {
                type: 'object',
                properties: {
                    limit: {type: 'number', description: 'Default 15'},
                    topic: {type: 'string', description: 'Adds up to 5 hybrid-search hits for this'},
                    includeCrawler: {type: 'boolean'}
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
            description: 'Notes related to a note by semantic similarity, links and shared tags, ranked with reasons.',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {type: 'string', description: 'Vault path'},
                    limit: {type: 'number', description: 'Default 10'}
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
            description: 'Open "- [ ]" items across the vault.',
            inputSchema: {
                type: 'object',
                properties: {
                    pathPrefix: {type: 'string', description: 'Folder'},
                    includeDone: {type: 'boolean', description: 'Include "- [x]"'}
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
            description: 'Notes not written, read or cited for a long time — candidates for review or deletion.',
            inputSchema: {
                type: 'object',
                properties: {
                    olderThanDays: {type: 'number', description: 'Default 90'},
                    pathPrefix: {type: 'string', description: 'Folder'},
                    limit: {type: 'number', description: 'Default 100'}
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
