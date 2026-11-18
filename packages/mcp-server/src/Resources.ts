import type {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {
    CompleteRequestSchema,
    ErrorCode,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    McpError,
    ReadResourceRequestSchema,
    type Prompt,
    type Resource
} from '@modelcontextprotocol/sdk/types.js';
import {auditContextStorage, isPathInScope, type SynaipseService} from '@synaipse/service';
import type {TokenScope} from './Auth.js';
import {buildInstructions} from './Instructions.js';
import {filterNotesByConsent, type ToolContext, type ToolHandler, type ToolResponse} from './Tools/Shared.js';

/**
 * MCP resources, prompts and completions (plan P8 / B5). Resources are a
 * thin layer over the read tools (read_note, prime, roadmap_get), called
 * through the same scope check, so `@`-mentioning a note in a client
 * shows exactly what the tool would.
 */

export interface ExtrasDeps {
    service: SynaipseService;
    project: string | null;
    ctx: ToolContext;
    scope: TokenScope;
    tools: ReadonlyMap<string, ToolHandler>;
    runTool: (name: string, args: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolResponse>;
}

const NOTE_PREFIX = 'synaipse://note/';
const PROJECT_URI = /^synaipse:\/\/project\/([^/]+)\/(primer|roadmap|convention)$/;
const NOTES_PAGE = 200;
const COMPLETION_MAX = 100;
const RESOURCE_NOT_FOUND = -32002;

export const noteUri = (id: string): string => NOTE_PREFIX + id.split('/').map(encodeURIComponent).join('/');

const projectUri = (project: string, kind: 'primer' | 'roadmap' | 'convention'): string =>
    `synaipse://project/${encodeURIComponent(project)}/${kind}`;

const textOf = (response: ToolResponse): string => {
    const first = response.content[0];
    return first !== undefined && first.type === 'text' ? first.text : '';
};

/** A tool error becomes a resource error (the message names the reason). */
const unwrap = (uri: string, response: ToolResponse): string => {
    const text = textOf(response);
    if (response.isError === true) {
        throw new McpError(/not found|No note/i.test(text) ? RESOURCE_NOT_FOUND : ErrorCode.InvalidParams, `${uri}: ${text}`);
    }
    return text;
};

/** Notes, projects and argument values the caller may see, inside the token's path scope. */
const inScope = <T>(deps: ExtrasDeps, fn: () => T): T =>
    auditContextStorage.run({tokenLabel: deps.scope.label, pathPrefixes: deps.scope.pathPrefixes}, fn);

const visibleNotes = (deps: ExtrasDeps) => inScope(deps, () =>
    filterNotesByConsent(deps.service.listNotes().filter((n) => isPathInScope(n.id))).items);

/** Projects with a folder under Memory/, plus the active one. */
const projectsOf = (deps: ExtrasDeps): string[] => {
    const names = new Set<string>(deps.project === null ? [] : [deps.project]);
    for (const n of visibleNotes(deps)) {
        const m = /^Memory\/([^/]+)\//.exec(n.id);
        if (m !== null && m[1] !== 'sessions') names.add(m[1]!);
    }
    return [...names].sort();
};

// ---- prompts ----------------------------------------------------------------

interface PromptSpec {
    prompt: Prompt;
    needs?: 'project' | 'roadmap';
    text: (args: Record<string, string>, project: string | null) => string;
}

const PROMPTS: PromptSpec[] = [
    {
        prompt: {
            name: 'session-to-vault',
            title: 'Session to vault',
            description: 'Save what this session decided, fixed or learned to Synaipse (proposal first, writes after approval).',
            arguments: [{name: 'focus', description: 'Optional: what to concentrate on'}]
        },
        text: (args) => [
            'Review this conversation and save what is worth remembering to Synaipse.',
            args.focus ? `Focus on: ${args.focus}.` : '',
            '',
            '1. List the decisions, fixes, gotchas and reusable patterns from this session. Skip routine work.',
            '2. For each, call synaipse_search first: if a note already covers it, plan an edit (synaipse_edit_note) instead of a new note.',
            '3. Pick the lightest write: synaipse_remember for a one-line insight, synaipse_log_session for a summary of what was done (with the notes used as references), synaipse_write_note for a decision, how-to or analysis worth its own note. If it replaces an older note, set frontmatter supersedes.',
            '4. Show the user one compact proposal (per item: tool, target note, 1–3 sentence text) and wait for approval before any write.',
            '5. After writing, check possibleDuplicates and warnings in the results and report what was saved.'
        ].filter((l) => l !== '').join('\n')
    },
    {
        prompt: {
            name: 'consolidate-inbox',
            title: 'Consolidate inbox',
            description: 'Merge the project\'s remember inbox into curated notes.',
            arguments: [{name: 'since', description: 'ISO date or span like "7d"; default all'}]
        },
        needs: 'project',
        text: (args) => [
            `Call synaipse_consolidate_inbox${args.since ? ` with since "${args.since}"` : ''}. For each entry:`,
            '- alreadyIn set: the knowledge is already in that note; the entry can be dropped.',
            '- otherwise: read the best target (synaipse_read_note, only the relevant section) and propose where the fact goes; if no target fits, propose a new note.',
            'Show the user a table (entry → action → note) and wait for approval. Then apply with synaipse_edit_note, and remove the handled entries from the inbox note (each entry is the section named by its time).'
        ].join('\n')
    },
    {
        prompt: {
            name: 'record-adr',
            title: 'Record decision (ADR)',
            description: 'Write an architecture decision record as a note under decisions/.',
            arguments: [
                {name: 'title', description: 'The decision in a few words', required: true},
                {name: 'context', description: 'Optional: background, options considered'}
            ]
        },
        text: (args) => [
            `Record the decision "${args.title ?? ''}" as a note.`,
            args.context ? `Context from the user: ${args.context}` : 'Take the context from this conversation; ask the user if the reasons are unclear.',
            '',
            '1. synaipse_search for earlier decisions on the same topic. If one is replaced, name it in frontmatter supersedes: ["<its title>"].',
            '2. synaipse_write_note with path "decisions/<kebab-case-slug>.md", mode "create", frontmatter {title, tags (2–5, prefer existing ones), type: "decision"} and the sections ## Context, ## Decision, ## Consequences, ## Alternatives. Link related notes with [[Title]].',
            '3. If the result lists possibleDuplicates, tell the user and offer to merge instead.'
        ].join('\n')
    },
    {
        prompt: {
            name: 'roadmap-review',
            title: 'Roadmap review',
            description: 'Check the project roadmap against recent work and propose status updates.'
        },
        needs: 'roadmap',
        text: () => [
            'Review the project roadmap.',
            '1. synaipse_roadmap_get for the current plan; synaipse_list with since "14d" for what changed recently (and synaipse_log_session entries under sessions/).',
            '2. Per step: is it done, started, blocked or outdated given that work? Note steps missing from the plan.',
            '3. Propose the changes (status per step, new steps, notes to link) and wait for approval; then apply them with synaipse_roadmap_update_step, synaipse_roadmap_plan and synaipse_roadmap_link_note.'
        ].join('\n')
    }
];

const promptAvailable = (spec: PromptSpec, deps: ExtrasDeps): boolean => {
    if (spec.needs === undefined) return true;
    if (deps.project === null) return false;
    return spec.needs === 'project' || deps.tools.has('synaipse_roadmap_get');
};

// ---- registration -----------------------------------------------------------

export const registerExtras = (server: Server, deps: ExtrasDeps): void => {
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
        resourceTemplates: deps.scope.read
            ? [
                {uriTemplate: `${NOTE_PREFIX}{+path}`, name: 'note', title: 'Vault note', description: 'A note by vault path, e.g. synaipse://note/Memory/<project>/decisions/x.md', mimeType: 'text/markdown'},
                {uriTemplate: 'synaipse://project/{project}/primer', name: 'primer', title: 'Project primer', description: 'Session context bundle (synaipse_prime)', mimeType: 'application/json'},
                {uriTemplate: 'synaipse://project/{project}/convention', name: 'convention', title: 'Vault convention', description: 'Working protocol and folder layout for the project', mimeType: 'text/markdown'},
                ...(deps.tools.has('synaipse_roadmap_get')
                    ? [{uriTemplate: 'synaipse://project/{project}/roadmap', name: 'roadmap', title: 'Project roadmap', mimeType: 'application/json'}]
                    : [])
            ]
            : []
    }));

    // Project resources first, then the notes newest first, one page at a time.
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
        if (!deps.scope.read) return {resources: []};

        const offset = /^\d+$/.test(request.params?.cursor ?? '') ? Number(request.params!.cursor) : 0;
        const project: Resource[] = offset > 0 || deps.project === null
            ? []
            : [
                {uri: projectUri(deps.project, 'primer'), name: `${deps.project} primer`, mimeType: 'application/json'},
                {uri: projectUri(deps.project, 'convention'), name: `${deps.project} convention`, mimeType: 'text/markdown'},
                ...(deps.tools.has('synaipse_roadmap_get') ? [{uri: projectUri(deps.project, 'roadmap'), name: `${deps.project} roadmap`, mimeType: 'application/json'}] : [])
            ];
        const notes = [...visibleNotes(deps)].sort((a, b) => b.mtime - a.mtime);
        const page = notes.slice(offset, offset + NOTES_PAGE);

        return {
            resources: [
                ...project,
                ...page.map((n) => ({uri: noteUri(n.id), name: n.id, title: n.title, mimeType: 'text/markdown'}))
            ],
            ...(offset + NOTES_PAGE < notes.length ? {nextCursor: String(offset + NOTES_PAGE)} : {})
        };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const uri = request.params.uri;

        if (uri.startsWith(NOTE_PREFIX)) {
            let id: string;
            try { id = decodeURIComponent(uri.slice(NOTE_PREFIX.length)); } catch { throw new McpError(ErrorCode.InvalidParams, `Bad note uri: ${uri}`); }
            const text = unwrap(uri, await deps.runTool('synaipse_read_note', {id, maxChars: 100_000}));
            const note = (JSON.parse(text) as {note: {content: string}}).note;
            return {contents: [{uri, mimeType: 'text/markdown', text: note.content}]};
        }

        const m = PROJECT_URI.exec(uri);
        if (m === null) throw new McpError(RESOURCE_NOT_FOUND, `Unknown resource: ${uri}`);

        const project = decodeURIComponent(m[1]!);
        const kind = m[2]!;
        const callCtx = {...deps.ctx, project};

        if (kind === 'convention') {
            if (!deps.scope.read) throw new McpError(ErrorCode.InvalidParams, 'Forbidden: token has no read access');
            return {contents: [{uri, mimeType: 'text/markdown', text: buildInstructions(project)}]};
        }

        const tool = kind === 'primer' ? 'synaipse_prime' : 'synaipse_roadmap_get';
        const text = unwrap(uri, await deps.runTool(tool, {}, callCtx));
        return {contents: [{uri, mimeType: 'application/json', text}]};
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
        prompts: PROMPTS.filter((p) => promptAvailable(p, deps)).map((p) => p.prompt)
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const spec = PROMPTS.find((p) => p.prompt.name === request.params.name);
        if (spec === undefined || !promptAvailable(spec, deps)) {
            throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${request.params.name}`);
        }

        const args = request.params.arguments ?? {};
        const missing = (spec.prompt.arguments ?? []).filter((a) => a.required === true && !(args[a.name] ?? '').trim());
        if (missing.length > 0) {
            throw new McpError(ErrorCode.InvalidParams, `Missing argument: ${missing.map((a) => a.name).join(', ')}`);
        }

        return {
            description: spec.prompt.description,
            messages: [{role: 'user' as const, content: {type: 'text' as const, text: spec.text(args, deps.project)}}]
        };
    });

    server.setRequestHandler(CompleteRequestSchema, async (request) => {
        const {name, value} = request.params.argument;
        const needle = value.toLowerCase();
        let candidates: string[] = [];

        if (name === 'path') {
            const ids = visibleNotes(deps).map((n) => n.id);
            // Prefix matches first, then anywhere in the path.
            candidates = [
                ...ids.filter((id) => id.toLowerCase().startsWith(needle)).sort(),
                ...ids.filter((id) => !id.toLowerCase().startsWith(needle) && id.toLowerCase().includes(needle)).sort()
            ];
        } else if (name === 'project') {
            candidates = projectsOf(deps).filter((p) => p.toLowerCase().startsWith(needle));
        } else if (name === 'since') {
            candidates = ['1d', '7d', '14d', '30d'].filter((s) => s.startsWith(needle));
        }

        return {
            completion: {
                values: candidates.slice(0, COMPLETION_MAX),
                total: candidates.length,
                hasMore: candidates.length > COMPLETION_MAX
            }
        };
    });
};

/**
 * Write results get a resource_link to the written note, so a client can
 * open it without a read_note round trip (plan P8 / B1).
 */
export const withNoteLink = (tool: string, response: ToolResponse): ToolResponse => {
    if (response.isError === true || !LINKED_WRITES.has(tool)) return response;
    try {
        const data = JSON.parse(textOf(response)) as {id?: unknown; title?: unknown};
        if (typeof data.id !== 'string') return response;
        return {
            ...response,
            content: [
                ...response.content,
                {type: 'resource_link', uri: noteUri(data.id), name: data.id, ...(typeof data.title === 'string' ? {title: data.title} : {}), mimeType: 'text/markdown'}
            ]
        };
    } catch {
        return response;
    }
};

const LINKED_WRITES = new Set(['synaipse_write_note', 'synaipse_update_note', 'synaipse_edit_note']);
