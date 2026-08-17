import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import type {Note, Roadmap, RoadmapStatus, RoadmapStep, SearchMode} from '@synaipse/core';
import {
    ROADMAP_STATUSES,
    appendActivity,
    extractTypedLinks,
    findStep,
    parseRoadmap,
    reconcilePlan,
    setActive,
    setStepDeleted,
    summarize,
    upsertStep
} from '@synaipse/core';
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
    // Roadmap tools scope on ctx.project (no pathArg — the note path is derived
    // from the project, never taken from the caller), like remember/log_session.
    synaipse_roadmap_plan:        {mode: 'write'},
    synaipse_roadmap_update_step: {mode: 'write'},
    synaipse_roadmap_set_active:  {mode: 'write'},
    synaipse_roadmap_link_note:   {mode: 'write'},
    synaipse_roadmap_get:         {mode: 'read'},
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

// --- Roadmap helpers -------------------------------------------------------

/** Who is mutating the roadmap — the auth token label, or "claude" in dev. */
const roadmapActor = (): string => getAuditTokenLabel() ?? 'claude';

/** Resolve the active project or throw a helpful error for roadmap tools. */
const requireRoadmapProject = (service: SynaipseService, ctx?: ToolContext): string => {
    const project = service.getProject(ctx?.project);
    if (project === null) {
        throw new Error(
            'No project context set. Roadmap tools operate per project — set one via the /mcp/<project> URL segment or the x-synaipse-project header.'
        );
    }
    return project;
};

const isRoadmapStatus = (value: unknown): value is RoadmapStatus =>
    typeof value === 'string' && (ROADMAP_STATUSES as readonly string[]).includes(value);

/** Apply an update_step field patch to a step, returning a new step. */
const patchStep = (step: RoadmapStep, args: Record<string, unknown>): RoadmapStep => {
    const next: RoadmapStep = {...step};
    if (typeof args.title === 'string' && args.title.length > 0) next.title = args.title;
    if (isRoadmapStatus(args.status)) next.status = args.status;
    if (typeof args.plannedHours === 'number') next.plannedHours = args.plannedHours;
    if (typeof args.actualHours === 'number') next.actualHours = args.actualHours;
    if (args.owner === 'ai' || args.owner === 'human') next.owner = args.owner;
    if (args.priority === 'low' || args.priority === 'med' || args.priority === 'high') next.priority = args.priority;
    if (typeof args.progress === 'number') next.progress = Math.max(0, Math.min(100, args.progress));
    if (typeof args.acceptance === 'string') next.acceptance = args.acceptance;
    if (typeof args.evaluation === 'string') next.evaluation = args.evaluation;
    if (Array.isArray(args.dependsOn)) {
        next.dependsOn = args.dependsOn.filter((d): d is string => typeof d === 'string');
    }
    return next;
};

/** Sanitize a caller-supplied step tree through the defensive core parser. */
const sanitizeSteps = (project: string, steps: unknown): RoadmapStep[] => {
    const parsed = parseRoadmap(project, {roadmap: {steps}});
    return parsed?.steps ?? [];
};

const roadmapResult = (roadmap: Roadmap): unknown => ({
    project: roadmap.project,
    summary: summarize(roadmap),
    active: roadmap.active,
    steps: roadmap.steps
});

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
    },
    // ─── Roadmap (per-project planning) ─────────────────────────────────────
    {
        definition: {
            name: 'synaipse_roadmap_get',
            description: 'Read the active project\'s roadmap: the full step tree (arbitrarily nested), the live "AI is working here" cursor, and a rolled-up summary (progress %, planned vs actual hours, done/blocked counts). Pass stepId to return only that step and its subtree. Returns an empty roadmap if none exists yet. Read this before planning or updating so you build on the current state.',
            inputSchema: {
                type: 'object',
                properties: {
                    stepId: {type: 'string', description: 'Optional: return only this step and its children.'}
                }
            }
        },
        handle: async (args, ctx) => {
            const project = requireRoadmapProject(service, ctx);
            const roadmap = service.readRoadmap(project);
            const stepId = typeof args.stepId === 'string' ? args.stepId : null;
            if (stepId !== null) {
                const step = findStep(roadmap.steps, stepId);
                return {
                    response: ok({project, step, summary: summarize(roadmap)}),
                    event: {kind: 'list', touched: []}
                };
            }
            return {response: ok(roadmapResult(roadmap)), event: {kind: 'list', touched: []}};
        }
    },
    {
        definition: {
            name: 'synaipse_roadmap_plan',
            description: 'Plan the roadmap for the active project. Two modes: (1) pass `steps` — an array of step objects — to REPLACE the whole tree (use for initial planning or restructuring); (2) pass a single `step` plus optional `parentId` to add or replace one step (append under a parent, or at root when parentId is omitted). Steps nest arbitrarily via each step\'s `children` array. Hours and progress roll up to parents automatically; open dependencies flip a step to "blocked". Writes Memory/<project>/_roadmap.md. SAFETY: the full-tree replace is non-destructive — per-step activity/audit logs are merged by id (an omitted activity list keeps existing history) and any step you leave out is kept as soft-deleted (hidden), never dropped. Prefer mode (2) for incremental edits.',
            inputSchema: {
                type: 'object',
                properties: {
                    steps: {
                        type: 'array',
                        description: 'Full step tree to replace the roadmap with. Each step: {id, title, status, plannedHours?, actualHours?, owner?("ai"|"human"), priority?("low"|"med"|"high"), noteLinks?, dependsOn?, acceptance?, evaluation?, children?}. Status one of: backlog, planned, in_progress, ai_active, review, blocked, done, cancelled. Use hierarchical ids like "1", "1.1", "2.3.1".',
                        items: {type: 'object'}
                    },
                    step: {type: 'object', description: 'Single step to upsert (alternative to steps).'},
                    parentId: {type: 'string', description: 'When upserting a single step, the parent step id to append under. Omit for a top-level step.'}
                }
            }
        },
        handle: async (args, ctx) => {
            const project = requireRoadmapProject(service, ctx);
            const current = service.readRoadmap(project);

            let nextSteps: RoadmapStep[];
            if (Array.isArray(args.steps)) {
                // Full-tree replace is reconciled against the current tree: activity
                // logs are merged by id and steps the incoming tree omits are kept as
                // soft-deleted (hidden) rather than dropped. Guards against a stale
                // replace silently wiping history — see reconcilePlan.
                nextSteps = reconcilePlan(current.steps, sanitizeSteps(project, args.steps));
            } else if (args.step !== undefined && args.step !== null) {
                const [sanitized] = sanitizeSteps(project, [args.step]);
                if (sanitized === undefined) {
                    throw new Error('step is missing a valid id/title.');
                }
                const parentId = typeof args.parentId === 'string' ? args.parentId : null;
                nextSteps = upsertStep(current.steps, sanitized, parentId);
            } else {
                throw new Error('Provide either `steps` (full tree) or `step` (single upsert).');
            }

            const saved = await service.writeRoadmap({...current, steps: nextSteps});
            const noteId = `Memory/${project}/_roadmap.md`;
            return {
                response: ok(roadmapResult(saved)),
                event: {kind: 'write', touched: [noteId]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_roadmap_update_step',
            description: 'Patch a single roadmap step by id: change status, book time (actualHours), adjust the estimate (plannedHours), set progress (0-100), owner, priority, acceptance criteria, or write your evaluation/rationale. Only the fields you pass change. Appends an activity-log entry to the step. Use this as you work — e.g. mark a step "review" and record what you did in `evaluation`.',
            inputSchema: {
                type: 'object',
                properties: {
                    stepId: {type: 'string', description: 'Id of the step to update.'},
                    status: {type: 'string', description: 'New status: backlog|planned|in_progress|ai_active|review|blocked|done|cancelled'},
                    title: {type: 'string'},
                    plannedHours: {type: 'number', description: 'Planned implementation time in hours.'},
                    actualHours: {type: 'number', description: 'Actual time spent in hours.'},
                    progress: {type: 'number', description: '0-100.'},
                    owner: {type: 'string', description: '"ai" or "human".'},
                    priority: {type: 'string', description: '"low", "med" or "high".'},
                    acceptance: {type: 'string', description: 'Definition of done.'},
                    evaluation: {type: 'string', description: 'Your assessment / rationale / remaining-estimate for this step.'},
                    dependsOn: {type: 'array', items: {type: 'string'}, description: 'Step ids this step depends on.'},
                    deleted: {type: 'boolean', description: 'Soft-delete (true) or restore (false) this step. Deleting cascades to sub-steps and hides them from KPIs/table/body, but the step is kept in the vault and stays reversible — steps are never hard-deleted.'},
                    note: {type: 'string', description: 'Optional activity-log message (defaults to a summary of changed fields).'}
                },
                required: ['stepId']
            }
        },
        handle: async (args, ctx) => {
            const project = requireRoadmapProject(service, ctx);
            const stepId = asString(args.stepId, 'stepId');
            const current = service.readRoadmap(project);
            const existing = findStep(current.steps, stepId);
            if (existing === null) {
                throw new Error(`Step "${stepId}" not found in the ${project} roadmap.`);
            }
            const patched = patchStep(existing, args);
            const changed = Object.keys(args).filter((k) => k !== 'stepId' && k !== 'note');
            const message = typeof args.note === 'string' && args.note.length > 0
                ? args.note
                : `updated ${changed.join(', ') || 'step'}`;
            const logged = appendActivity(patched, {at: new Date().toISOString(), who: roadmapActor(), what: message});
            let nextSteps = upsertStep(current.steps, logged);
            // Soft-delete/restore cascades to sub-steps; steps are never hard-removed.
            if (typeof args.deleted === 'boolean') {
                nextSteps = setStepDeleted(nextSteps, stepId, args.deleted);
            }
            const saved = await service.writeRoadmap({...current, steps: nextSteps});
            return {
                response: ok({project, step: findStep(saved.steps, stepId), summary: summarize(saved)}),
                event: {kind: 'write', touched: [`Memory/${project}/_roadmap.md`]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_roadmap_set_active',
            description: 'Set the live "AI is working here" cursor to a step: it becomes status "ai_active" and any previously-active step drops back to "in_progress". Pass stepId=null (or omit) to clear the cursor. At most one step is active at a time. Call this when you start working on a step so the UI shows a live indicator; call update_step to record progress and clear when you move on.',
            inputSchema: {
                type: 'object',
                properties: {
                    stepId: {type: 'string', description: 'Step to mark active. Omit or pass empty to clear the cursor.'}
                }
            }
        },
        handle: async (args, ctx) => {
            const project = requireRoadmapProject(service, ctx);
            const current = service.readRoadmap(project);
            const stepId = typeof args.stepId === 'string' && args.stepId.length > 0 ? args.stepId : null;
            if (stepId !== null && findStep(current.steps, stepId) === null) {
                throw new Error(`Step "${stepId}" not found in the ${project} roadmap.`);
            }
            const actor = roadmapActor();
            const updated = setActive(current, stepId, new Date().toISOString(), actor);
            const saved = await service.writeRoadmap(updated);
            return {
                response: ok({project, active: saved.active, summary: summarize(saved)}),
                event: {kind: 'write', touched: [`Memory/${project}/_roadmap.md`]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_roadmap_link_note',
            description: 'Attach note links to a roadmap step. Pass note titles or vault paths — they are stored on the step and rendered as [[wikilinks]] in the roadmap body, so backlinks and graph edges work. Idempotent: already-linked notes are skipped.',
            inputSchema: {
                type: 'object',
                properties: {
                    stepId: {type: 'string', description: 'Step to link notes to.'},
                    notes: {type: 'array', items: {type: 'string'}, description: 'Note titles or paths to link (become [[Title]]).'}
                },
                required: ['stepId', 'notes']
            }
        },
        handle: async (args, ctx) => {
            const project = requireRoadmapProject(service, ctx);
            const stepId = asString(args.stepId, 'stepId');
            const notes = Array.isArray(args.notes)
                ? args.notes.filter((n): n is string => typeof n === 'string' && n.length > 0)
                : [];
            const current = service.readRoadmap(project);
            const existing = findStep(current.steps, stepId);
            if (existing === null) {
                throw new Error(`Step "${stepId}" not found in the ${project} roadmap.`);
            }
            const have = new Set(existing.noteLinks ?? []);
            const added = notes.filter((n) => !have.has(n));
            const merged: RoadmapStep = {...existing, noteLinks: [...(existing.noteLinks ?? []), ...added]};
            const logged = added.length > 0
                ? appendActivity(merged, {at: new Date().toISOString(), who: roadmapActor(), what: `linked ${added.join(', ')}`})
                : merged;
            await service.writeRoadmap({...current, steps: upsertStep(current.steps, logged)});
            return {
                response: ok({project, stepId, added, skipped: notes.filter((n) => have.has(n))}),
                event: {kind: 'write', touched: [`Memory/${project}/_roadmap.md`]}
            };
        }
    }
]);