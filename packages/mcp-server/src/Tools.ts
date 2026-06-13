import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import type {SearchMode} from '@synaipse/core';
import {SynaipseService} from '@synaipse/service';
import type {EventKind} from './EventPublisher.js';

export interface ToolResponse {
    content: Array<{type: 'text'; text: string}>;
    isError?: boolean;
}

export interface ToolEventInfo {
    kind: EventKind;
    touched: string[];
    query?: string;
}

export interface ToolOutcome {
    response: ToolResponse;
    event?: ToolEventInfo;
}

const ok = (data: unknown): ToolResponse => ({
    content: [{type: 'text', text: JSON.stringify(data, null, 2)}]
});

const asString = (value: unknown, field: string): string => {
    if (typeof value !== 'string') {
        throw new Error(`Missing string argument: ${field}`);
    }

    return value;
};

const asNumber = (value: unknown, fallback: number): number => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    return fallback;
};

const asSearchMode = (value: unknown): SearchMode => {
    if (value === 'fulltext' || value === 'semantic' || value === 'hybrid') {
        return value;
    }

    return 'hybrid';
};

export interface ToolHandler {
    definition: Tool;
    handle: (args: Record<string, unknown>) => Promise<ToolOutcome>;
}

export const buildTools = (service: SynaipseService): ToolHandler[] => [
    {
        definition: {
            name: 'synaipse_search',
            description: 'Search the Synaipse knowledge base. Modes: fulltext (keywords), semantic (meaning), hybrid (both). Use semantic for concept questions, fulltext for exact terms, hybrid by default.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: {type: 'string', description: 'Search query'},
                    mode: {type: 'string', enum: ['fulltext', 'semantic', 'hybrid'], description: 'Search strategy (default: hybrid)'},
                    limit: {type: 'number', description: 'Max results (default: 10)'}
                },
                required: ['query']
            }
        },
        handle: async (args) => {
            const query = asString(args.query, 'query');
            const hits = await service.search(query, asSearchMode(args.mode), asNumber(args.limit, 10));
            return {
                response: ok({hits}),
                event: {kind: 'search', touched: hits.slice(0, 5).map((h) => h.noteId), query}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_read_note',
            description: 'Read a single note by id (relative path from vault root, e.g. "Memory/decisions/auth.md").',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {type: 'string', description: 'Note id (relative path)'}
                },
                required: ['id']
            }
        },
        handle: async (args) => {
            const id = asString(args.id, 'id');
            const note = service.readNote(id);
            return {response: ok({note}), event: {kind: 'read', touched: [id]}};
        }
    },
    {
        definition: {
            name: 'synaipse_write_note',
            description: 'Create or overwrite a note. Provide id/path (relative to vault), markdown content and optional YAML frontmatter. Returns the parsed note.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {type: 'string', description: 'Note path relative to vault, e.g. "Memory/decisions/2026-06-11-auth.md"'},
                    content: {type: 'string', description: 'Markdown body (without frontmatter)'},
                    frontmatter: {
                        type: 'object',
                        description: 'Optional YAML frontmatter (title, tags, aliases, created, updated, ...)',
                        additionalProperties: true
                    }
                },
                required: ['path', 'content']
            }
        },
        handle: async (args) => {
            const frontmatter = args.frontmatter as Record<string, unknown> | undefined;
            const note = await service.writeNote({
                path: asString(args.path, 'path'),
                content: asString(args.content, 'content'),
                ...(frontmatter ? {frontmatter} : {})
            });
            return {response: ok({note}), event: {kind: 'write', touched: [note.id]}};
        }
    },
    {
        definition: {
            name: 'synaipse_delete_note',
            description: 'Permanently delete a note from the vault and remove it from the vector index.',
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
            await service.deleteNote(id);
            return {response: ok({deleted: true}), event: {kind: 'delete', touched: [id]}};
        }
    },
    {
        definition: {
            name: 'synaipse_list_notes',
            description: 'List notes in the vault (returns id, title, tags, mtime). Useful for browsing or building a sitemap.',
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
            const limit = asNumber(args.limit, 200);

            const notes = service.listNotes()
                .filter((n) => n.id.startsWith(prefix))
                .slice(0, limit)
                .map((n) => ({id: n.id, title: n.title, tags: n.tags, mtime: n.mtime}));

            return {response: ok({notes}), event: {kind: 'list', touched: []}};
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
                .map(([tag, ids]) => ({tag, count: ids.length}))
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
            const notes = ids
                .map((id) => service.getVault().tryGet(id))
                .filter((n): n is NonNullable<typeof n> => n !== undefined)
                .map((n) => ({id: n.id, title: n.title, tags: n.tags}));
            return {response: ok({notes}), event: {kind: 'list', touched: ids.slice(0, 10)}};
        }
    },
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
            return {response: ok({backlinks}), event: {kind: 'list', touched: [id, ...backlinks.slice(0, 5)]}};
        }
    },
    {
        definition: {
            name: 'synaipse_outgoing_links',
            description: 'List wikilinks contained in the given note (resolved + unresolved).',
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
            const note = service.readNote(id);
            return {response: ok({wikilinks: note.wikilinks}), event: {kind: 'list', touched: [id]}};
        }
    },
    {
        definition: {
            name: 'synaipse_graph',
            description: 'Return the knowledge graph (nodes + wikilink edges). Use for visualisation or structural reasoning.',
            inputSchema: {type: 'object', properties: {}}
        },
        handle: async () => ({response: ok({graph: service.graph()}), event: {kind: 'graph', touched: []}})
    },
    {
        definition: {
            name: 'synaipse_log_session',
            description: 'Append a structured entry to today\'s session log in Memory/sessions/YYYY-MM-DD.md. Use this to record what you worked on, key insights, and the notes you referenced. Each call appends a new heading-3 entry with the current time. Wikilinks to references are added automatically.',
            inputSchema: {
                type: 'object',
                properties: {
                    summary: {type: 'string', description: 'Short narrative of what was worked on and any insights (1-5 sentences)'},
                    references: {
                        type: 'array',
                        items: {type: 'string'},
                        description: 'Note titles to wikilink (e.g. ["Voyage Embeddings", "Qdrant Setup"]). These become [[Wikilinks]] in the log entry.'
                    }
                },
                required: ['summary']
            }
        },
        handle: async (args) => {
            const summary = asString(args.summary, 'summary');
            const references = Array.isArray(args.references)
                ? args.references.filter((r): r is string => typeof r === 'string')
                : [];

            const sessionId = await service.appendSessionLog(summary, references);
            return {
                response: ok({sessionId, references, time: new Date().toISOString()}),
                event: {kind: 'write', touched: [sessionId]}
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
            const related = await service.related(id, asNumber(args.limit, 10));
            return {
                response: ok({related}),
                event: {kind: 'search', touched: [id, ...related.slice(0, 5).map((r) => r.id)]}
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
            const todos = service.todos(prefix, includeDone);
            return {
                response: ok({todos, count: todos.length}),
                event: {kind: 'list', touched: [...new Set(todos.slice(0, 10).map((t) => t.noteId))]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_link_note',
            description: 'Append wikilinks to a target note under a section heading (default: "References"). Idempotent — existing links are skipped. Use this to add cross-references without rewriting the whole note.',
            inputSchema: {
                type: 'object',
                properties: {
                    fromId: {type: 'string', description: 'Source note id (relative path)'},
                    toTitles: {
                        type: 'array',
                        items: {type: 'string'},
                        description: 'Titles of notes to link to (will become [[Title]] wikilinks)'
                    },
                    section: {type: 'string', description: 'Section heading to append under (default: "References")'}
                },
                required: ['fromId', 'toTitles']
            }
        },
        handle: async (args) => {
            const fromId = asString(args.fromId, 'fromId');
            const toTitles = Array.isArray(args.toTitles)
                ? args.toTitles.filter((t): t is string => typeof t === 'string')
                : [];
            const section = typeof args.section === 'string' ? args.section : 'References';
            const {note, added} = await service.linkNote(fromId, toTitles, section);
            return {
                response: ok({noteId: note.id, added, skipped: toTitles.filter((t) => !added.includes(t))}),
                event: {kind: 'write', touched: [note.id]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_update_note',
            description: 'Partial update: change content and/or merge into frontmatter without rewriting unchanged parts. frontmatterPatch shallow-merges over existing keys.',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {type: 'string', description: 'Note id (relative path)'},
                    content: {type: 'string', description: 'New markdown body (optional, leaves content unchanged if omitted)'},
                    frontmatterPatch: {
                        type: 'object',
                        description: 'Shallow-merged into existing frontmatter (optional)',
                        additionalProperties: true
                    }
                },
                required: ['id']
            }
        },
        handle: async (args) => {
            const id = asString(args.id, 'id');
            const patch: {content?: string; frontmatterPatch?: Record<string, unknown>} = {};

            if (typeof args.content === 'string') {
                patch.content = args.content;
            }

            if (args.frontmatterPatch !== undefined && args.frontmatterPatch !== null && typeof args.frontmatterPatch === 'object') {
                patch.frontmatterPatch = args.frontmatterPatch as Record<string, unknown>;
            }

            const note = await service.updateNote(id, patch);
            return {response: ok({note}), event: {kind: 'write', touched: [note.id]}};
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
            const limit = asNumber(args.limit, 20);
            const sorted = [...service.listNotes()]
                .sort((a, b) => b.mtime - a.mtime)
                .slice(0, limit);
            const notes = sorted.map((n) => ({id: n.id, title: n.title, mtime: n.mtime}));
            return {response: ok({notes}), event: {kind: 'list', touched: sorted.slice(0, 5).map((n) => n.id)}};
        }
    }
];