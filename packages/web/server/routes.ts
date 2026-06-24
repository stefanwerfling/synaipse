import type {IncomingMessage, ServerResponse} from 'node:http';
import type {Frontmatter} from '@synaipse/core';
import type {ChatgptImportConversation, ChatSourceRef, ChatTurn, PrimerEntry, PrimerReason, PrimeResult, SynaipseService, TodoItem} from '@synaipse/service';
import type {EventBroadcaster, SynaipseEvent} from './events.js';
 import type {JobManager, JobParams, JobType} from './jobs.js';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(body));
};

const notFound = (res: ServerResponse): void => json(res, 404, {error: 'not found'});

const methodNotAllowed = (res: ServerResponse): void => json(res, 405, {error: 'method not allowed'});

const readJson = async <T>(req: IncomingMessage): Promise<T> => {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
        chunks.push(chunk as Buffer);
    }

    const raw = Buffer.concat(chunks).toString('utf8');

    if (raw.length === 0) {
        throw new Error('empty body');
    }

    return JSON.parse(raw) as T;
};

interface WriteNoteBody {
    content?: unknown;
    frontmatter?: unknown;
}

const asString = (value: unknown, field: string): string => {
    if (typeof value !== 'string') {
        throw new Error(`field '${field}' must be string`);
    }

    return value;
};

const parseTurnsForRequest = (raw: unknown): ChatTurn[] => {
    if (!Array.isArray(raw)) {
        throw new Error("field 'turns' must be an array");
    }

    const out: ChatTurn[] = [];

    for (const item of raw) {
        if (typeof item !== 'object' || item === null) continue;
        const t = item as Record<string, unknown>;
        if (t.role !== 'user' && t.role !== 'assistant') continue;
        if (typeof t.content !== 'string') continue;

        const turn: ChatTurn = {role: t.role, content: t.content};

        if (typeof t.model === 'string') turn.model = t.model;

        if (Array.isArray(t.sources)) {
            const sources: ChatSourceRef[] = [];
            for (const s of t.sources) {
                if (typeof s !== 'object' || s === null) continue;
                const src = s as Record<string, unknown>;
                if (typeof src.target !== 'string') continue;
                if (typeof src.title !== 'string') continue;
                if (typeof src.index !== 'number') continue;

                const ref: ChatSourceRef = {target: src.target, title: src.title, index: src.index};
                if (typeof src.score === 'number') ref.score = src.score;
                if (typeof src.snippet === 'string') ref.snippet = src.snippet;
                sources.push(ref);
            }
            if (sources.length > 0) turn.sources = sources;
        }

        out.push(turn);
    }

    return out;
};

const REASON_HEADINGS: Record<PrimerReason, string> = {
    pinned: 'Pinned',
    recent_session: 'Recent sessions',
    project_decision: 'Project decisions',
    topic: 'Topic-relevant',
    hot: 'Hot (by backlink count)',
    recent: 'Recently edited'
};

const REASON_ORDER: readonly PrimerReason[] = [
    'pinned',
    'recent_session',
    'project_decision',
    'topic',
    'hot',
    'recent'
];

const renderPrimerMarkdown = (result: PrimeResult): string => {
    const lines: string[] = [];
    const project = result.project ?? '(unscoped)';
    const generatedAt = new Date().toISOString();

    lines.push(`# Synaipse Primer — ${project}`);
    lines.push('');
    lines.push(
        `*Generated ${generatedAt}. ${result.context.length} context entries, ` +
        `${result.todoCount} open TODOs, ~${result.tokenEstimate} tokens.*`
    );
    lines.push('');
    lines.push('This file is regenerated on every Claude Code session start by the');
    lines.push('`synaipse-memory` plugin. Read the listed notes via `synaipse_read_note`');
    lines.push('when their topic comes up in this session.');
    lines.push('');

    const grouped = new Map<PrimerReason, PrimerEntry[]>();

    for (const entry of result.context) {
        const existing = grouped.get(entry.reason);

        if (existing) {
            existing.push(entry);
        } else {
            grouped.set(entry.reason, [entry]);
        }
    }

    for (const reason of REASON_ORDER) {
        const entries = grouped.get(reason);

        if (entries === undefined || entries.length === 0) {
            continue;
        }

        lines.push(`## ${REASON_HEADINGS[reason]}`);
        lines.push('');

        for (const entry of entries) {
            const excerpt = entry.excerpt.replace(/\s+/g, ' ').trim().slice(0, 200);
            lines.push(`- **${entry.title}** (\`${entry.id}\`) — ${excerpt}`);
        }

        lines.push('');
    }

    if (result.todoSample.length > 0) {
        lines.push('## TODOs (sample)');
        lines.push('');

        for (const todo of result.todoSample) {
            lines.push(`- [ ] from \`${todo.noteId}\`: ${todo.text}`);
        }

        lines.push('');
    }

    return lines.join('\n');
};

const writeTextPlain = (res: ServerResponse, status: number, body: string): void => {
    res.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8'});
    res.end(body);
};

const asFrontmatter = (value: unknown): Frontmatter | undefined => {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error("field 'frontmatter' must be object");
    }

    return value as Frontmatter;
};

export const routes = (
    service: SynaipseService,
    broadcaster: EventBroadcaster,
    jobs: JobManager
): Handler => async (req, res, url) => {
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/api/events/stream') {
        if (method !== 'GET') {
            methodNotAllowed(res);
            return;
        }

        broadcaster.addClient(res);
        return;
    }

    if (path === '/api/events') {
        if (method !== 'POST') {
            methodNotAllowed(res);
            return;
        }

        const body = await readJson<SynaipseEvent>(req);
        broadcaster.publish(body);
        json(res, 200, {ok: true, clients: broadcaster.clientCount()});
        return;
    }

    if (path === '/api/notes') {
        if (method !== 'GET') {
            methodNotAllowed(res);
            return;
        }

        json(res, 200, service.listNotes().map((n) => ({
            id: n.id,
            title: n.title,
            tags: n.tags,
            mtime: n.mtime,
            aliases: Array.isArray(n.frontmatter.aliases)
                ? n.frontmatter.aliases.filter((a): a is string => typeof a === 'string')
                : []
        })));
        return;
    }

    if (path.startsWith('/api/notes/')) {
        const tail = decodeURIComponent(path.slice('/api/notes/'.length));

        const historyMatch = tail.match(/^(.+)\/history$/);

        if (historyMatch !== null) {
            if (method !== 'GET') {
                methodNotAllowed(res);
                return;
            }

            const id = historyMatch[1] as string;
            const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
            const entries = await service.noteHistory(id, Number.isFinite(limit) ? limit : 50);
            json(res, 200, {entries});
            return;
        }

        const versionMatch = tail.match(/^(.+)\/version\/([0-9a-f]+)$/);

        if (versionMatch !== null) {
            if (method !== 'GET') {
                methodNotAllowed(res);
                return;
            }

            try {
                const content = await service.noteVersion(versionMatch[1] as string, versionMatch[2] as string);
                json(res, 200, {content, sha: versionMatch[2]});
            } catch (error) {
                json(res, 404, {error: String(error)});
            }
            return;
        }

        const summarizeMatch = tail.match(/^(.+)\/summarize$/);

        if (summarizeMatch !== null) {
            if (method !== 'POST') {
                methodNotAllowed(res);
                return;
            }

            const id = summarizeMatch[1] as string;
            const bodyJson = await readJson<{save?: unknown}>(req).catch(() => ({save: false}));
            const save = bodyJson.save === true;

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            const ctl = new AbortController();
            req.on('close', () => ctl.abort());

            try {
                for await (const event of service.summarizeNote(id, {abort: ctl.signal, saveToFrontmatter: save})) {
                    res.write(`data: ${JSON.stringify(event)}\n\n`);
                }
            } catch (error) {
                res.write(`data: ${JSON.stringify({kind: 'error', message: String(error)})}\n\n`);
            }

            res.end();
            return;
        }

        const diffMatch = tail.match(/^(.+)\/diff$/);

        if (diffMatch !== null) {
            if (method !== 'GET') {
                methodNotAllowed(res);
                return;
            }

            const from = url.searchParams.get('from');
            const to = url.searchParams.get('to');

            if (from === null) {
                json(res, 400, {error: 'missing ?from='});
                return;
            }

            try {
                const unified = await service.noteDiff(diffMatch[1] as string, from, to ?? undefined);
                json(res, 200, {unified});
            } catch (error) {
                json(res, 500, {error: String(error)});
            }
            return;
        }

        const id = tail;

        if (method === 'GET') {
            const note = service.getVault().tryGet(id);

            if (!note) {
                notFound(res);
                return;
            }

            json(res, 200, note);
            return;
        }

        if (method === 'PUT') {
            const body = await readJson<WriteNoteBody>(req);
            const content = asString(body.content, 'content');
            const frontmatter = asFrontmatter(body.frontmatter);

            const note = await service.writeNote({
                path: id,
                content,
                ...(frontmatter ? {frontmatter} : {})
            });

            json(res, 200, note);
            return;
        }

        if (method === 'DELETE') {
            await service.deleteNote(id);
            json(res, 200, {deleted: true});
            return;
        }

        methodNotAllowed(res);
        return;
    }

    if (path === '/api/assets/upload') {
        if (method !== 'POST') {
            methodNotAllowed(res);
            return;
        }

        const noteId = decodeURIComponent(req.headers['x-synaipse-note-id'] as string ?? '');

        if (noteId === '') {
            json(res, 400, {error: 'missing X-Synaipse-Note-Id header'});
            return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        const MAX_BYTES = 25 * 1024 * 1024;

        for await (const chunk of req) {
            const buf = chunk as Buffer;
            total += buf.length;

            if (total > MAX_BYTES) {
                json(res, 413, {error: 'asset exceeds 25 MB limit'});
                return;
            }

            chunks.push(buf);
        }

        const body = Buffer.concat(chunks, total);
        const contentType = (req.headers['content-type'] as string | undefined) ?? null;

        if (body.length === 0) {
            json(res, 400, {error: 'empty body'});
            return;
        }

        try {
            const result = await service.writeNoteAsset(noteId, body, contentType);
            json(res, 200, result);
        } catch (error) {
            json(res, 500, {error: String(error)});
        }

        return;
    }

    if (path === '/api/jobs') {
        if (method === 'GET') {
            json(res, 200, jobs.listJobs());
            return;
        }

        if (method === 'POST') {
            const body = await readJson<{type?: unknown; params?: unknown}>(req);

            if (body.type !== 'relink' && body.type !== 'compile') {
                json(res, 400, {error: "field 'type' must be 'relink' or 'compile'"});
                return;
            }

            if (typeof body.params !== 'object' || body.params === null) {
                json(res, 400, {error: "field 'params' must be object"});
                return;
            }

            const params = body.params as Record<string, unknown>;

            if (typeof params.prefix !== 'string') {
                json(res, 400, {error: "params.prefix must be a string (empty = all notes)"});
                return;
            }

            const record = jobs.startJob(body.type as JobType, body.params as JobParams);
            json(res, 200, record);
            return;
        }

        methodNotAllowed(res);
        return;
    }

    if (path.startsWith('/api/jobs/')) {
        const tail = path.slice('/api/jobs/'.length);
        const streamMatch = tail.match(/^([^/]+)\/stream$/);
        const stopMatch = tail.match(/^([^/]+)\/stop$/);

        if (streamMatch !== null) {
            if (method !== 'GET') {
                methodNotAllowed(res);
                return;
            }

            const jobId = streamMatch[1] as string;
            const job = jobs.getJob(jobId);

            if (job === undefined) {
                notFound(res);
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            // Replay current state so the client doesn't need a separate GET first.
            res.write(`data: ${JSON.stringify({
                kind: 'snapshot',
                job
            })}\n\n`);

            const unsubscribe = jobs.subscribe(jobId, (event) => {
                res.write(`data: ${JSON.stringify(event)}\n\n`);

                if (event.kind === 'done' || event.kind === 'failed' || event.kind === 'stopped') {
                    res.end();
                }
            });

            req.on('close', unsubscribe);
            return;
        }

        if (stopMatch !== null) {
            if (method !== 'POST') {
                methodNotAllowed(res);
                return;
            }

            const ok = jobs.stopJob(stopMatch[1] as string);
            json(res, ok ? 200 : 404, {ok});
            return;
        }

        if (method === 'GET') {
            const job = jobs.getJob(tail);

            if (job === undefined) {
                notFound(res);
                return;
            }

            json(res, 200, job);
            return;
        }

        methodNotAllowed(res);
        return;
    }

    if (path === '/api/clip') {
        if (method !== 'POST') {
            methodNotAllowed(res);
            return;
        }

        // Permissive CORS so a browser extension content script can POST
        // without preflight gymnastics. The server only listens on localhost
        // so this is safe by default.
        res.setHeader('Access-Control-Allow-Origin', '*');

        const body = await readJson<{
            url?: unknown;
            title?: unknown;
            html?: unknown;
            markdown?: unknown;
            selection?: unknown;
            tags?: unknown;
            excerpt?: unknown;
        }>(req);

        const url = asString(body.url, 'url');
        const title = asString(body.title, 'title');

        let markdown: string;

        if (typeof body.markdown === 'string' && body.markdown.length > 0) {
            markdown = body.markdown;
        } else if (typeof body.html === 'string' && body.html.length > 0) {
            const {default: TurndownService} = await import('turndown');
            const td = new TurndownService({headingStyle: 'atx', codeBlockStyle: 'fenced'});
            markdown = td.turndown(body.html);
        } else {
            json(res, 400, {error: "either 'markdown' or 'html' must be provided"});
            return;
        }

        if (typeof body.selection === 'string' && body.selection.length > 0) {
            markdown = `> **Selection:**\n> \n> ${body.selection.replace(/\n/g, '\n> ')}\n\n---\n\n${markdown}`;
        }

        const tags = Array.isArray(body.tags)
            ? body.tags.filter((t): t is string => typeof t === 'string')
            : [];
        const excerpt = typeof body.excerpt === 'string' ? body.excerpt : undefined;

        try {
            const result = await service.clipPage({
                url,
                title,
                markdown,
                tags,
                ...(excerpt !== undefined ? {excerpt} : {})
            });
            json(res, 200, result);
        } catch (error) {
            json(res, 500, {error: String(error)});
        }

        return;
    }

    if (method === 'OPTIONS' && path === '/api/clip') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.writeHead(204);
        res.end();
        return;
    }

    if (path === '/api/import/chatgpt/existing') {
        if (method !== 'GET') {
            methodNotAllowed(res);
            return;
        }

        const map: Record<string, string> = {};

        for (const [chatgptId, noteId] of service.listChatgptImports().entries()) {
            map[chatgptId] = noteId;
        }

        json(res, 200, map);
        return;
    }

    if (path === '/api/import/chatgpt') {
        if (method !== 'POST') {
            methodNotAllowed(res);
            return;
        }

        const body = await readJson<{conversation?: unknown}>(req);
        const conv = body.conversation;

        if (typeof conv !== 'object' || conv === null) {
            json(res, 400, {error: "field 'conversation' must be object"});
            return;
        }

        try {
            const result = await service.importChatgptConversation(conv as ChatgptImportConversation);
            json(res, 200, result);
        } catch (error) {
            json(res, 500, {error: String(error)});
        }

        return;
    }

    if (path === '/api/activity') {
        if (method !== 'GET') {
            methodNotAllowed(res);
            return;
        }

        const sinceDays = Number.parseInt(url.searchParams.get('days') ?? '7', 10);
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '1000', 10);

        const report = await service.getActivity({
            ...(Number.isFinite(sinceDays) && sinceDays > 0 ? {sinceDays} : {}),
            ...(Number.isFinite(limit) && limit > 0 ? {limit} : {})
        });

        json(res, 200, report);
        return;
    }

    if (path === '/api/sessions/log') {
        if (method !== 'POST') {
            methodNotAllowed(res);
            return;
        }

        const body = await readJson<{summary?: unknown; references?: unknown}>(req);
        const summary = asString(body.summary, 'summary');
        const references = Array.isArray(body.references)
            ? body.references.filter((r): r is string => typeof r === 'string')
            : [];

        const sessionId = await service.appendSessionLog(summary, references);
        json(res, 200, {sessionId});
        return;
    }

    if (path === '/api/health/verify') {
        if (method !== 'GET') {
            methodNotAllowed(res);
            return;
        }

        const report = await service.verifyHistory();

        if (report === null) {
            json(res, 200, {enabled: false});
            return;
        }

        json(res, 200, {enabled: true, ...report});
        return;
    }

    if (path.startsWith('/api/snapshot/')) {
        if (method !== 'GET') {
            methodNotAllowed(res);
            return;
        }

        const tail = decodeURIComponent(path.slice('/api/snapshot/'.length));

        if (!/^[0-9a-f]{40}(?:\/.*)?$/.test(tail)) {
            json(res, 400, {error: 'expected /api/snapshot/<40-char-sha>[/<sub>]'});
            return;
        }

        const slashIdx = tail.indexOf('/');
        const sha = slashIdx === -1 ? tail : tail.slice(0, slashIdx);
        const op = slashIdx === -1 ? '' : tail.slice(slashIdx + 1);

        try {
            if (op === '' || op === 'list') {
                const treePath = url.searchParams.get('path') ?? undefined;
                const entries = await service.snapshotList(sha, treePath);
                json(res, 200, {sha, path: treePath ?? '', entries});
                return;
            }

            if (op === 'walk') {
                const prefix = url.searchParams.get('prefix') ?? '';
                const files = await service.snapshotWalk(sha, prefix);
                json(res, 200, {sha, prefix, count: files.length, files});
                return;
            }

            json(res, 404, {error: `unknown snapshot op: ${op}`});
        } catch (error) {
            json(res, 404, {error: String(error)});
        }

        return;
    }

    if (path === '/api/prime') {
        if (method !== 'GET') {
            methodNotAllowed(res);
            return;
        }

        const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '15', 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 15;
        const topic = url.searchParams.get('topic') ?? '';
        const includeCrawler = url.searchParams.get('includeCrawler') === 'true';
        const format = url.searchParams.get('format') ?? 'json';
        const projectParam = url.searchParams.get('project');
        const project = projectParam !== null && projectParam.length > 0
            ? projectParam
            : service.getProject();

        const result = await service.prime({
            project,
            limit,
            ...(topic.length > 0 ? {topic} : {}),
            includeCrawler
        });

        if (format === 'markdown') {
            writeTextPlain(res, 200, renderPrimerMarkdown(result));
            return;
        }

        json(res, 200, result);
        return;
    }

    if (path === '/api/info') {
        if (method !== 'GET') {
            methodNotAllowed(res);
            return;
        }

        json(res, 200, {
            semanticEnabled: service.hasSemanticIndex(),
            notesCount: service.listNotes().length,
            project: service.getProject(),
            historyEnabled: await service.historyEnabled(),
            chatEnabled: service.chatEnabled(),
            chatModel: service.getChatModel(),
            chatProvider: service.getChatProviderKind(),
            chatProviderIsLocal: service.getChatProviderIsLocal(),
            researchEnabled: service.researchEnabled(),
            researchProvider: service.getResearchProviderKind()
        });
        return;
    }

    if (path === '/api/research') {
        if (method !== 'POST') {
            methodNotAllowed(res);
            return;
        }

        const body = await readJson<{question?: unknown}>(req);
        const question = asString(body.question, 'question');

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        });

        const ctl = new AbortController();
        req.on('close', () => ctl.abort());

        try {
            for await (const event of service.research(question, {abort: ctl.signal})) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
        } catch (error) {
            res.write(`data: ${JSON.stringify({kind: 'error', message: String(error)})}\n\n`);
        }

        res.end();
        return;
    }

    if (path === '/api/chat') {
        if (method !== 'POST') {
            methodNotAllowed(res);
            return;
        }

        const body = await readJson<{question?: unknown; pathPrefix?: unknown; history?: unknown}>(req);
        const question = asString(body.question, 'question');
        const pathPrefix = typeof body.pathPrefix === 'string' ? body.pathPrefix : undefined;

        const history: Array<{role: 'user' | 'assistant'; content: string}> = [];

        if (Array.isArray(body.history)) {
            for (const raw of body.history) {
                if (typeof raw !== 'object' || raw === null) continue;
                const r = raw as Record<string, unknown>;
                const role = r.role;
                const content = r.content;

                if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
                    history.push({role, content});
                }
            }
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        });

        const ctl = new AbortController();
        req.on('close', () => ctl.abort());

        try {
            for await (const event of service.chat({
                question,
                ...(pathPrefix !== undefined ? {pathPrefix} : {}),
                ...(history.length > 0 ? {history} : {}),
                abort: ctl.signal
            })) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
        } catch (error) {
            res.write(`data: ${JSON.stringify({kind: 'error', message: String(error)})}\n\n`);
        }

        res.end();
        return;
    }

    if (path === '/api/chats') {
        if (method === 'GET') {
            json(res, 200, await service.listChats());
            return;
        }

        if (method === 'POST') {
            try {
                const body = await readJson<{
                    title?: unknown;
                    lastModel?: unknown;
                    turns?: unknown;
                }>(req);

                const title = asString(body.title, 'title');
                const turns = parseTurnsForRequest(body.turns);
                const lastModel = typeof body.lastModel === 'string' ? body.lastModel : undefined;

                const session = await service.createChat(
                    lastModel !== undefined ? {title, turns, lastModel} : {title, turns}
                );
                json(res, 201, session);
            } catch (error) {
                json(res, 400, {error: String(error)});
            }
            return;
        }

        methodNotAllowed(res);
        return;
    }

    if (path.startsWith('/api/chats/')) {
        const tail = decodeURIComponent(path.slice('/api/chats/'.length));

        // POST /api/chats/<id>/save-as-note — promote a stored chat into
        // a real vault note. Body is empty / optional.
        const saveAsNoteMatch = tail.match(/^(.+)\/save-as-note$/);
        if (saveAsNoteMatch !== null && method === 'POST') {
            const id = saveAsNoteMatch[1] as string;
            try {
                const noteId = await service.saveChatAsNote(id);
                json(res, 201, {noteId});
            } catch (error) {
                json(res, 400, {error: String(error)});
            }
            return;
        }

        const id = tail;

        if (method === 'GET') {
            try {
                json(res, 200, await service.getChat(id));
            } catch (error) {
                json(res, 404, {error: String(error)});
            }
            return;
        }

        if (method === 'PUT') {
            try {
                const body = await readJson<{
                    title?: unknown;
                    lastModel?: unknown;
                    turns?: unknown;
                }>(req);

                const title = asString(body.title, 'title');
                const turns = parseTurnsForRequest(body.turns);
                const lastModel = typeof body.lastModel === 'string' ? body.lastModel : undefined;

                const updated = await service.updateChat(
                    id,
                    lastModel !== undefined ? {title, turns, lastModel} : {title, turns}
                );
                json(res, 200, updated);
            } catch (error) {
                json(res, 400, {error: String(error)});
            }
            return;
        }

        if (method === 'DELETE') {
            try {
                await service.deleteChat(id);
                json(res, 200, {ok: true});
            } catch (error) {
                json(res, 400, {error: String(error)});
            }
            return;
        }

        methodNotAllowed(res);
        return;
    }

    if (path === '/api/search') {
        if (method !== 'GET') {
            methodNotAllowed(res);
            return;
        }

        const q = url.searchParams.get('q') ?? '';
        const mode = (url.searchParams.get('mode') ?? 'hybrid') as 'fulltext' | 'semantic' | 'hybrid';
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
        const hits = await service.search(q, mode, limit);
        json(res, 200, hits);
        return;
    }

    if (path === '/api/graph') {
        if (method !== 'GET') {
            methodNotAllowed(res);
            return;
        }

        json(res, 200, service.graph());
        return;
    }

    if (path === '/api/graph/layout') {
        if (method !== 'GET') {
            methodNotAllowed(res);
            return;
        }

        json(res, 200, service.graphLayout());
        return;
    }

    if (path === '/api/tags') {
        if (method !== 'GET') {
            methodNotAllowed(res);
            return;
        }

        const tags = [...service.tags().entries()].map(([tag, ids]) => ({tag, count: ids.length}));
        json(res, 200, tags);
        return;
    }

    notFound(res);
};