import {canonicalNoteLink, resolveNoteRefTarget} from '@synaipse/core';
import {isAllowedAssetMime, isPathInScope, MIME_TO_EXT, type SynaipseService} from '@synaipse/service';
import {extractSection, headingsOf, modifiedOf, resolveNoteId, writeResult} from './Format.js';
import {asString, enforceReadConsent, ok, type ToolHandler} from './Shared.js';

/** Default cap for read_note bodies; long notes are cut with a hint how to page. */
const READ_DEFAULT_MAX_CHARS = 20_000;

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
            description: 'Active project context: folder, tag, extra tags, git author. Project-scoped writes go to Memory/<project>/.',
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
            description: 'Read a note by vault path, title or alias. `section` returns only the part under one heading; `offset`/`maxChars` page through long notes.',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {type: 'string', description: 'Vault path, title or alias'},
                    section: {type: 'string', description: 'Heading text (case-insensitive)'},
                    offset: {type: 'integer', minimum: 0, description: 'Default 0'},
                    maxChars: {type: 'integer', minimum: 1, maximum: 100000, description: 'Default 20000'}
                },
                required: ['id']
            }
        },
        handle: async (args) => {
            const id = resolveNoteId(service, asString(args.id, 'id'));
            const note = await enforceReadConsent(service, id);

            let body = note.content;
            if (typeof args.section === 'string' && args.section.trim().length > 0) {
                const section = extractSection(note.content, args.section);
                if (section === null) {
                    const headings = headingsOf(note.content);
                    throw new Error(
                        `Section "${args.section}" not found in ${id}.`
                        + (headings.length > 0 ? ` Headings: ${headings.slice(0, 30).map((h) => `"${h}"`).join(', ')}` : ' The note has no headings.')
                    );
                }
                body = section;
            }

            const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.trunc(args.offset) : 0;
            const maxChars = typeof args.maxChars === 'number' ? Math.min(100_000, Math.max(1, Math.trunc(args.maxChars))) : READ_DEFAULT_MAX_CHARS;
            const end = Math.min(body.length, offset + maxChars);
            const truncated = offset > 0 || end < body.length;

            const {path: _path, mtime, content: _content, ...rest} = note;
            // Tell the reader when this knowledge is outdated (plan P8 / B4).
            const state = service.knowledgeState(id);
            return {
                response: ok({
                    note: {
                        ...rest,
                        ...modifiedOf(mtime),
                        ...(state?.supersededBy !== undefined ? {supersededBy: state.supersededBy} : {}),
                        ...(state?.expired === true ? {expired: true} : {}),
                        content: body.slice(offset, end),
                        ...(truncated ? {range: {offset, end, total: body.length}, ...(end < body.length ? {next: `offset: ${end}`} : {})} : {})
                    }
                }),
                event: {kind: 'read', touched: [id]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_write_note',
            description: 'Create or overwrite a note; relative paths land in the project folder. Search first to avoid duplicates. Returns {id, hash, warnings?} — warnings name dead wikilinks.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {type: 'string', description: 'e.g. "decisions/auth.md"'},
                    content: {type: 'string', description: 'Markdown body without frontmatter'},
                    frontmatter: {
                        type: 'object',
                        description: 'title, tags, aliases, …',
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
            return {response: ok(writeResult(service, note)), event: {kind: 'write', touched: [note.id]}};
        }
    },
    {
        definition: {
            name: 'synaipse_write_asset',
            description: `Upload an image (base64) into the project's _assets/ folder, deduped by content hash. With noteId the result includes a relativePath for ![](…). Upload before writing the note that embeds it. Allowed: ${Object.keys(MIME_TO_EXT).join(', ')}.`,
            inputSchema: {
                type: 'object',
                properties: {
                    data: {type: 'string', description: 'Base64 bytes, no data: prefix (max SYNAIPSE_ASSET_MAX_BYTES, default 10 MB)'},
                    contentType: {type: 'string', description: 'MIME type, e.g. "image/png"'},
                    noteId: {type: 'string', description: 'Note that will embed the asset'}
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
            description: 'Delete a note and drop it from the index (recoverable from version history when enabled).',
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
            description: 'Append to today\'s session log: what you did, insights, and the notes you used — references become [[links]] and count as "used" for ranking.',
            inputSchema: {
                type: 'object',
                properties: {
                    summary: {type: 'string', description: '1-5 sentences'},
                    references: {
                        type: 'array',
                        items: {type: 'string'},
                        description: 'Titles of notes you used'
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
            description: 'Append a one-line insight to today\'s inbox (Memory/<project>/inbox/YYYY-MM-DD.md) — for captures not yet worth a curated note.',
            inputSchema: {
                type: 'object',
                properties: {
                    text: {type: 'string', description: '1-3 sentences'},
                    tags: {
                        type: 'array',
                        items: {type: 'string'},
                        description: 'Inline tags, without #'
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
            description: 'Append [[links]] to a note under a heading (default "References"). Targets (titles, aliases, paths) must resolve to existing notes, else nothing is linked. Idempotent.',
            inputSchema: {
                type: 'object',
                properties: {
                    fromId: {type: 'string', description: 'Note to add the links to'},
                    toTitles: {
                        type: 'array',
                        items: {type: 'string'},
                        description: 'Titles, aliases or vault paths'
                    },
                    section: {type: 'string'}
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

            // Same resolution + validation as roadmap_link_note: store the
            // canonical title so graph/backlinks pick the link up.
            const targets = service.listNotes()
                .filter((n) => isPathInScope(n.id))
                .map((n) => ({
                    id: n.id,
                    title: n.title,
                    aliases: Array.isArray(n.frontmatter.aliases) ? n.frontmatter.aliases.filter((a): a is string => typeof a === 'string') : []
                }));
            const resolved: string[] = [];
            const unresolved: string[] = [];
            for (const ref of toTitles) {
                const target = resolveNoteRefTarget(ref, targets);
                if (target === null) unresolved.push(ref);
                else resolved.push(canonicalNoteLink(target));
            }
            if (unresolved.length > 0) {
                throw new Error(
                    `These link targets resolve to no existing note: ${unresolved.map((r) => `"${r}"`).join(', ')}. `
                    + 'Use an exact title, alias or vault path (synaipse_search finds it). Nothing was linked.'
                );
            }

            const {note, added} = await service.linkNote(fromId, resolved, section, ctx);
            return {
                response: ok({noteId: note.id, added, skipped: resolved.filter((t) => !added.includes(t))}),
                event: {kind: 'write', touched: [note.id]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_update_note',
            description: 'Replace the body and/or shallow-merge frontmatterPatch. For a few changed lines prefer synaipse_edit_note. Returns {id, hash, changed, warnings?}.',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {type: 'string'},
                    content: {type: 'string', description: 'New body (omit to keep)'},
                    frontmatterPatch: {
                        type: 'object',
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

            const previousHash = service.tryReadNote(id)?.hash;
            const note = await service.updateNote(id, patch, ctx);
            return {response: ok(writeResult(service, note, previousHash)), event: {kind: 'write', touched: [note.id]}};
        }
    },
    {
        definition: {
            name: 'synaipse_edit_note',
            description: 'Find/replace in a note body without resending it. Each oldString must match exactly once (or set replaceAll); edits apply in order, and nothing is written if one fails. Frontmatter: use update_note. Returns {id, hash, changed, warnings?}.',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {type: 'string'},
                    edits: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                oldString: {type: 'string', description: 'Exact text'},
                                newString: {type: 'string', description: 'May be empty'},
                                replaceAll: {type: 'boolean'}
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
            return {response: ok(writeResult(service, note, existing.hash)), event: {kind: 'write', touched: [note.id]}};
        }
    }
];
