import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import type {Note, SearchMode} from '@synaipse/core';
import {extractTypedLinks} from '@synaipse/core';
import {SynaipseService, getAuditTokenLabel, isAllowedAssetMime, MIME_TO_EXT} from '@synaipse/service';
import type {EventKind} from './EventPublisher.js';

const CONSENT_TIMEOUT_MS = 60_000;

/**
 * Enforce just-in-time consent for note reads triggered by MCP. When
 * the note's `frontmatter.mcp_consent === "pending"`, the tool handler
 * blocks up to CONSENT_TIMEOUT_MS on a UI-side approve/deny before
 * returning the note or throwing.
 *
 * Callers that don't require the whole note (list/aggregate tools)
 * MUST NOT go through this path; they use {@link filterByConsent}
 * instead, which silently drops pending/denied entries.
 */
const enforceReadConsent = async (service: SynaipseService, id: string): Promise<Note> => {
    const initial = service.readNote(id);
    const status = initial.frontmatter.mcp_consent;

    if (status === undefined || status === 'granted') {
        return initial;
    }

    if (status === 'denied') {
        throw new Error(`Note "${id}" is denied for MCP access by user consent.`);
    }

    // status === 'pending' → long-poll the UI
    const requester = getAuditTokenLabel() ?? 'unknown';
    const result = await service.getConsentStore().request(id, requester, CONSENT_TIMEOUT_MS);

    if (result === 'timeout') {
        throw new Error(`Note "${id}" needs user consent before MCP can read it. Prompt is pending in the UI; retry the tool call in a moment.`);
    }

    if (result === 'denied') {
        throw new Error(`Note "${id}" was denied by user consent.`);
    }

    // Approved. service.resolveConsent already wrote the decision to
    // frontmatter; re-read so the returned note reflects the new state.
    return service.readNote(id);
};

/**
 * Silently drop notes that are consent-blocked (pending or denied)
 * from aggregate result lists. Notes without an `mcp_consent` field
 * pass through unchanged — the consent layer is opt-in per note.
 * Returns the filtered list plus the number that were removed so
 * callers can surface a `skippedByConsent` count.
 */
const filterByConsent = <T>(
    service: SynaipseService,
    items: readonly T[],
    getId: (item: T) => string
): {items: T[]; skipped: number} => {
    const kept: T[] = [];
    let skipped = 0;

    for (const item of items) {
        const id = getId(item);
        const note = service.tryReadNote(id);
        const status = note?.frontmatter.mcp_consent;
        if (status === 'pending' || status === 'denied') {
            skipped++;
            continue;
        }
        kept.push(item);
    }

    return {items: kept, skipped};
};

/**
 * Same as {@link filterByConsent} for lists of Note objects.
 */
const filterNotesByConsent = (
    notes: readonly Note[]
): {items: Note[]; skipped: number} => {
    const kept: Note[] = [];
    let skipped = 0;
    for (const note of notes) {
        const status = note.frontmatter.mcp_consent;
        if (status === 'pending' || status === 'denied') {
            skipped++;
            continue;
        }
        kept.push(note);
    }
    return {items: kept, skipped};
};

const DEFAULT_ASSET_MAX_BYTES = 10 * 1024 * 1024;

const assetMaxBytes = (): number => {
    const raw = process.env.SYNAIPSE_ASSET_MAX_BYTES;
    if (raw === undefined || raw.trim() === '') return DEFAULT_ASSET_MAX_BYTES;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ASSET_MAX_BYTES;
};

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const decodeBase64Strict = (value: string): Buffer => {
    // node Buffer.from('...', 'base64') silently drops invalid chars — that
    // hides upload bugs (truncated payloads look "valid"). Validate the
    // alphabet up front so a corrupted upload fails loudly.
    const cleaned = value.replace(/\s/g, '');

    if (cleaned.length === 0) {
        throw new Error('data is empty');
    }

    if (!BASE64_RE.test(cleaned)) {
        throw new Error('data is not valid base64');
    }

    return Buffer.from(cleaned, 'base64');
};

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

export interface ToolContext {
    project?: string | null;
    gitAuthor?: {name: string; email: string};
    extraTags?: readonly string[];
}

const EMPTY_CTX: ToolContext = {};

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
    /**
     * ACL category. Read-only tools (search, read, list, graph, …) are
     * gated on the token's read scope; mutating tools (write/update/
     * delete/link/log/remember) on the write scope. Default 'read' so
     * the long list of read-only tool definitions stays uncluttered.
     */
    mode?: 'read' | 'write';
    /**
     * Name of the input field carrying the note path, if any. The
     * scope check uses it to compare against `pathPrefixes`. Tools
     * without a path argument (search, list_tags, recent, …) leave
     * this undefined and skip the path-prefix check.
     */
    pathArg?: string;
    handle: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolOutcome>;
}

/**
 * ACL classification for every tool, applied as a post-pass to
 * `buildTools()`. Kept as a table here (rather than inline per tool
 * definition) so the 24-tool list stays scannable and adding/removing
 * write tools is one line, not a hunt-for-the-right-position edit.
 */
const ACL_TABLE: Record<string, {mode: 'read' | 'write'; pathArg?: string}> = {
    synaipse_write_note:   {mode: 'write', pathArg: 'path'},
    synaipse_update_note:  {mode: 'write', pathArg: 'path'},
    synaipse_edit_note:    {mode: 'write', pathArg: 'id'},
    synaipse_delete_note:  {mode: 'write', pathArg: 'id'},
    synaipse_write_asset:  {mode: 'write', pathArg: 'noteId'},
    synaipse_link_note:    {mode: 'write', pathArg: 'source'},
    synaipse_log_session:  {mode: 'write'},
    synaipse_remember:     {mode: 'write'},
    synaipse_read_note:    {mode: 'read',  pathArg: 'id'},
    synaipse_backlinks:    {mode: 'read',  pathArg: 'id'},
    synaipse_outgoing_links: {mode: 'read', pathArg: 'id'},
    synaipse_related:      {mode: 'read',  pathArg: 'id'}
};

const applyAcl = (tools: readonly ToolHandler[]): ToolHandler[] => tools.map((t) => {
    const entry = ACL_TABLE[t.definition.name];
    return {
        ...t,
        mode: entry?.mode ?? 'read',
        ...(entry?.pathArg !== undefined ? {pathArg: entry.pathArg} : {})
    };
});

export {EMPTY_CTX};

export const buildTools = (service: SynaipseService): ToolHandler[] => applyAcl([
    {
        definition: {
            name: 'synaipse_get_project',
            description: 'Return the active project context. When set, write_note auto-prefixes paths to Memory/<project>/, injects a project/<name> tag and frontmatter.project; update/delete/link/log_session are restricted to Memory/<project>/. Useful for Claude to verify scope before acting.',
            inputSchema: {type: 'object', properties: {}}
        },
        handle: async (_args, ctx) => {
            const name = service.getProject(ctx?.project);
            const extraTags = ctx?.extraTags ?? service.getConfigExtraTags();
            return {
                response: ok({
                    project: name,
                    isSet: name !== null,
                    folder: name === null ? null : `Memory/${name}/`,
                    tag: name === null ? null : `project/${name}`,
                    extraTags,
                    gitAuthor: ctx?.gitAuthor ?? null
                }),
                event: {kind: 'list', touched: []}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_verify_history',
            description: 'Health-check the ngit history store inside the vault. Re-hashes every stored object and reports whether the on-disk content still matches. Returns {enabled: false} when versioning is disabled.',
            inputSchema: {type: 'object', properties: {}}
        },
        handle: async () => {
            const report = await service.verifyHistory();

            if (report === null) {
                return {response: ok({enabled: false}), event: {kind: 'list', touched: []}};
            }

            return {
                response: ok({enabled: true, ...report}),
                event: {kind: 'list', touched: []}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_snapshot_list',
            description: 'List entries (files + sub-trees) of the vault as they existed at a past commit. Use to browse the vault state historically, or to compare folder contents across two points in time. Returns an empty list when versioning is disabled.',
            inputSchema: {
                type: 'object',
                properties: {
                    sha: {type: 'string', description: '40-char commit sha to view'},
                    path: {type: 'string', description: 'Optional folder inside the snapshot, e.g. "Memory/decisions/"'}
                },
                required: ['sha']
            }
        },
        handle: async (args) => {
            const sha = asString(args.sha, 'sha');
            const treePath = typeof args.path === 'string' ? args.path : undefined;
            const entries = await service.snapshotList(sha, treePath);
            return {
                response: ok({sha, path: treePath ?? '', entries}),
                event: {kind: 'list', touched: []}
            };
        }
    },
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
            const raw = await service.search(query, asSearchMode(args.mode), asNumber(args.limit, 10));const stripped = explain
                ? raw
                : raw.map(({components: _components, ...rest}) => rest);
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
            const note = await enforceReadConsent(service, id);
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
        handle: async (args, ctx) => {
            const frontmatter = args.frontmatter as Record<string, unknown> | undefined;
            const note = await service.writeNote({
                path: asString(args.path, 'path'),
                content: asString(args.content, 'content'),
                ...(frontmatter ? {frontmatter} : {})
            }, ctx);
            return {response: ok({note}), event: {kind: 'write', touched: [note.id]}};
        }
    },
    {
        definition: {
            name: 'synaipse_write_asset',
            description: `Upload a binary asset (image/svg/png/jpg/gif/webp/avif) into the project's _assets/ folder. The file is hashed and deduped — re-uploading the same bytes returns the existing assetId. When noteId is given, the response includes a note-relative relativePath ready to drop into a markdown ![](…) link. Use this BEFORE synaipse_write_note / synaipse_update_note when adding images to a note. Allowed MIME types: ${Object.keys(MIME_TO_EXT).join(', ')}.`,
            inputSchema: {
                type: 'object',
                properties: {
                    data: {type: 'string', description: 'Base64-encoded file bytes (no data: URL prefix). Max size configurable via SYNAIPSE_ASSET_MAX_BYTES (default 10 MB).'},
                    contentType: {type: 'string', description: 'MIME type, e.g. "image/png", "image/svg+xml". Determines the file extension.'},
                    noteId: {type: 'string', description: 'Optional vault-relative note id (e.g. "Memory/proj/decision-x.md"). When given, the asset is anchored to that note and the response carries a ready-to-embed relativePath. When omitted, the asset still lands in Memory/<project>/_assets/ but you build the link yourself.'}
                },
                required: ['data', 'contentType']
            }
        },
        handle: async (args, ctx) => {
            const contentType = asString(args.contentType, 'contentType');

            if (!isAllowedAssetMime(contentType)) {
                throw new Error(`contentType "${contentType}" is not an allowed asset MIME (allowed: ${Object.keys(MIME_TO_EXT).join(', ')})`);
            }

            const buffer = decodeBase64Strict(asString(args.data, 'data'));
            const max = assetMaxBytes();

            if (buffer.length > max) {
                throw new Error(`asset is ${buffer.length} bytes, exceeds limit ${max} (raise SYNAIPSE_ASSET_MAX_BYTES to override)`);
            }

            const noteId = typeof args.noteId === 'string' && args.noteId.length > 0 ? args.noteId : undefined;
            const result = await service.writeAssetScoped(
                {content: buffer, contentType, ...(noteId !== undefined ? {noteId} : {})},
                ctx
            );

            return {response: ok({asset: result}), event: {kind: 'write', touched: [result.assetId]}};
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
        handle: async (args, ctx) => {
            const id = asString(args.id, 'id');
            await service.deleteNote(id, ctx);
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

            const raw = service.listNotes().filter((n) => n.id.startsWith(prefix));
            const filtered = filterNotesByConsent(raw);
            const notes = filtered.items
                .slice(0, limit)
                .map((n) => ({id: n.id, title: n.title, tags: n.tags, mtime: n.mtime}));

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
        handle: async (args, ctx) => {
            const summary = asString(args.summary, 'summary');
            const references = Array.isArray(args.references)
                ? args.references.filter((r): r is string => typeof r === 'string')
                : [];

            const sessionId = await service.appendSessionLog(summary, references, ctx);
            return {
                response: ok({sessionId, references, time: new Date().toISOString()}),
                event: {kind: 'write', touched: [sessionId]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_remember',
            description: 'Append a one-line insight to today\'s inbox at Memory/<project>/inbox/YYYY-MM-DD.md. Use this for lightweight captures that don\'t deserve a full note yet (e.g. "qdrant client v2 drops the legacy upsert API" or "Stefan prefers PascalCase for src/ files") — somewhere between log_session (narrative) and write_note (curated note). Each call appends a heading-3 entry with the current time; tags are rendered inline as #foo #bar.',
            inputSchema: {
                type: 'object',
                properties: {
                    text: {type: 'string', description: 'The insight in 1-3 sentences. Leading/trailing whitespace is trimmed.'},
                    tags: {
                        type: 'array',
                        items: {type: 'string'},
                        description: 'Optional inline tags (without #). Rendered as #tag on a separate line below the text. Not added to frontmatter to keep the inbox file tag list clean.'
                    }
                },
                required: ['text']
            }
        },
        handle: async (args, ctx) => {
            const text = asString(args.text, 'text');
            const tags = Array.isArray(args.tags)
                ? args.tags.filter((t): t is string => typeof t === 'string')
                : [];

            const noteId = await service.appendInboxEntry(text, tags, ctx);
            return {
                response: ok({noteId, tags, time: new Date().toISOString()}),
                event: {kind: 'write', touched: [noteId]}
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
            const raw = await service.related(id, asNumber(args.limit, 10));
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
            const limit = asNumber(args.limit, 20);
            const minScore = typeof args.minScore === 'number' ? args.minScore : 0.65;
            const pathPrefix = typeof args.pathPrefix === 'string' ? args.pathPrefix : '';
            const suggestions = await service.suggestLinks({limit, minScore, pathPrefix});
            return {
                response: ok({suggestions, count: suggestions.length}),
                event: {
                    kind: 'search',
                    touched: [...new Set(suggestions.slice(0, 5).flatMap((s) => [s.a, s.b]))]
                }
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
                    olderThanDays: {type: 'number', description: 'Threshold in days (default: 90). A note is stale when max(mtime, lastAccessed) is older than this.'},
                    pathPrefix: {type: 'string', description: 'Restrict to a folder, e.g. "Memory/research/"'},
                    limit: {type: 'number', description: 'Max results (default: 100)'}
                }
            }
        },
        handle: async (args) => {
            const olderThanDays = typeof args.olderThanDays === 'number' ? args.olderThanDays : 90;
            const pathPrefix = typeof args.pathPrefix === 'string' ? args.pathPrefix : '';
            const limit = asNumber(args.limit, 100);
            const raw = service.staleNotes({olderThanDays, pathPrefix, limit});
            const filtered = filterByConsent(service, raw, (n) => n.id);
            return {
                response: ok({
                    notes: filtered.items,
                    count: filtered.items.length,
                    olderThanDays,
                    ...(filtered.skipped > 0 ? {skippedByConsent: filtered.skipped} : {})
                }),
                event: {kind: 'list', touched: filtered.items.slice(0, 5).map((n) => n.id)}
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
        handle: async (args, ctx) => {
            const fromId = asString(args.fromId, 'fromId');
            const toTitles = Array.isArray(args.toTitles)
                ? args.toTitles.filter((t): t is string => typeof t === 'string')
                : [];
            const section = typeof args.section === 'string' ? args.section : 'References';
            const {note, added} = await service.linkNote(fromId, toTitles, section, ctx);
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
        handle: async (args, ctx) => {
            const id = asString(args.id, 'id');
            const patch: {content?: string; frontmatterPatch?: Record<string, unknown>} = {};

            if (typeof args.content === 'string') {
                patch.content = args.content;
            }

            if (args.frontmatterPatch !== undefined && args.frontmatterPatch !== null && typeof args.frontmatterPatch === 'object') {
                patch.frontmatterPatch = args.frontmatterPatch as Record<string, unknown>;
            }

            const note = await service.updateNote(id, patch, ctx);
            return {response: ok({note}), event: {kind: 'write', touched: [note.id]}};
        }
    },
    {
        definition: {
            name: 'synaipse_edit_note',
            description: 'Find/replace inside a note body without resending the whole content — the point of this tool over update_note is to avoid transferring an unchanged 400-line note back through MCP just to change three lines. Each edit fails loudly (Error) if oldString isn\'t found or matches more than once; use replaceAll:true to opt into multi-match. Edits are applied in the given order against the intermediate body, so a later edit sees the earlier ones. Frontmatter is not touched — use update_note for that.',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {type: 'string', description: 'Note id (relative path)'},
                    edits: {
                        type: 'array',
                        description: 'Ordered list of body edits',
                        items: {
                            type: 'object',
                            properties: {
                                oldString: {type: 'string', description: 'Literal text to find in the current body. Must match exactly once (or set replaceAll).'},
                                newString: {type: 'string', description: 'Replacement text. May be empty to delete.'},
                                replaceAll: {type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness. Default false.'}
                            },
                            required: ['oldString', 'newString']
                        },
                        minItems: 1
                    }
                },
                required: ['id', 'edits']
            }
        },
        handle: async (args, ctx) => {
            const id = asString(args.id, 'id');
            const rawEdits = args.edits;

            if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
                throw new Error('edits must be a non-empty array');
            }

            const existing = service.readNote(id);
            let body = existing.content;

            for (let i = 0; i < rawEdits.length; i++) {
                const edit = rawEdits[i] as Record<string, unknown>;
                const oldString = asString(edit.oldString, `edits[${i}].oldString`);
                const newString = asString(edit.newString, `edits[${i}].newString`);
                const replaceAll = edit.replaceAll === true;

                if (oldString.length === 0) {
                    throw new Error(`edits[${i}]: oldString is empty`);
                }
                if (oldString === newString) {
                    throw new Error(`edits[${i}]: oldString equals newString — no-op edit`);
                }

                const first = body.indexOf(oldString);
                if (first === -1) {
                    throw new Error(`edits[${i}]: oldString not found in note body`);
                }

                if (replaceAll) {
                    body = body.split(oldString).join(newString);
                    continue;
                }

                const second = body.indexOf(oldString, first + 1);
                if (second !== -1) {
                    throw new Error(
                        `edits[${i}]: oldString matches multiple times — add surrounding context to make it unique, or set replaceAll:true`
                    );
                }

                body = body.slice(0, first) + newString + body.slice(first + oldString.length);
            }

            const note = await service.updateNote(id, {content: body}, ctx);
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
                .sort((a, b) => b.mtime - a.mtime);
            const filtered = filterNotesByConsent(sorted);
            const notes = filtered.items
                .slice(0, limit)
                .map((n) => ({id: n.id, title: n.title, mtime: n.mtime}));
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
            description: 'Return a curated context bundle for the current project: pinned notes, recent sessions, project decisions, topic-relevant notes (when topic is given), hot notes (by backlink count), and recently-edited notes — plus a TODO digest. Each entry carries a "reason" tag so you can prioritise. Crawler/ content (external imports — GitHub stars, dev.to articles) is excluded from hot/recent/todos by default; pass includeCrawler:true to include it. Topic search always includes Crawler/ — if you ask for a topic, you want hits. Call this once at session start (or when switching context) to prime yourself with what matters most before doing anything else.',
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
            const limit = asNumber(args.limit, 15);
            const topic = typeof args.topic === 'string' ? args.topic : '';
            const includeCrawler = args.includeCrawler === true;
            const result = await service.prime({project: ctx?.project ?? null, limit, topic, includeCrawler});
            const filteredCtx = filterByConsent(service, result.context, (e) => e.id);
            const filteredTodos = filterByConsent(service, result.todoSample, (t) => t.noteId);
            const skipped = filteredCtx.skipped + filteredTodos.skipped;
            const primed = {
                ...result,
                context: filteredCtx.items,
                todoSample: filteredTodos.items,
                ...(skipped > 0 ? {skippedByConsent: skipped} : {})
            };
            return {
                response: ok(primed),
                event: {kind: 'list', touched: primed.context.slice(0, 5).map((e) => e.id)}
            };
        }
    }
]);