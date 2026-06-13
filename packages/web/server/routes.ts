import type {IncomingMessage, ServerResponse} from 'node:http';
import type {Frontmatter} from '@synaipse/core';
import type {SynaipseService} from '@synaipse/service';
import type {EventBroadcaster, SynaipseEvent} from './events.js';

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

const asFrontmatter = (value: unknown): Frontmatter | undefined => {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error("field 'frontmatter' must be object");
    }

    return value as Frontmatter;
};

export const routes = (service: SynaipseService, broadcaster: EventBroadcaster): Handler => async (req, res, url) => {
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
        const id = decodeURIComponent(path.slice('/api/notes/'.length));

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

    if (path === '/api/info') {
        if (method !== 'GET') {
            methodNotAllowed(res);
            return;
        }

        json(res, 200, {
            semanticEnabled: service.hasSemanticIndex(),
            notesCount: service.listNotes().length
        });
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