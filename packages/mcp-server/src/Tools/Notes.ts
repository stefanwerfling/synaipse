import {isAllowedAssetMime, MIME_TO_EXT, type SynaipseService} from '@synaipse/service';
import {asString, enforceReadConsent, ok, type ToolHandler} from './Shared.js';

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

/** Project context + note CRUD, assets, quick captures. */
export const noteTools = (service: SynaipseService): ToolHandler[] => [
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

            // Same consent gate as read_note: edit_note returns the note,
            // so a pending/denied note must not leak through here.
            const existing = await enforceReadConsent(service, id);
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
    }
];
