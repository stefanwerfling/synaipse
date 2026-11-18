import {describe, expect, it} from 'vitest';
import {Readable} from 'node:stream';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {SynaipseService} from '@synaipse/service';
import type {EventBroadcaster} from '../server/events.js';
import type {JobManager} from '../server/jobs.js';
import {HttpError, Router, withErrorMapping} from '../server/router.js';
import {decodeCursor, encodeCursor, isRecord, keysetPage} from '../server/pagination.js';
import {routes} from '../server/routes.js';
import {JSON_BODY_LIMIT, readJsonBody} from '../server/body.js';

interface Captured {
    status: number;
    headers: Record<string, string>;
    body: unknown;
    headersSent: boolean;
}

const request = (method: string, path: string, body?: string | Buffer): {req: IncomingMessage; url: URL} => {
    const chunks = body === undefined ? [] : [typeof body === 'string' ? Buffer.from(body) : body];
    const req = Readable.from(chunks) as unknown as IncomingMessage;
    Object.assign(req, {method, url: path, headers: {}});
    return {req, url: new URL(path, 'http://x')};
};

const response = (): {res: ServerResponse; out: Captured} => {
    const out: Captured = {status: 0, headers: {}, body: undefined, headersSent: false};
    const res = {
        get headersSent() {
            return out.headersSent;
        },
        writeHead(status: number, headers: Record<string, string> = {}) {
            out.status = status;
            out.headers = headers;
            out.headersSent = true;
            return this;
        },
        setHeader() {},
        write() {
            return true;
        },
        end(chunk?: string | Buffer) {
            if (chunk !== undefined) {
                const text = chunk.toString();
                try {
                    out.body = JSON.parse(text);
                } catch {
                    out.body = text;
                }
            }
            return this;
        }
    } as unknown as ServerResponse;
    return {res, out};
};

const call = async (
    handler: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>,
    method: string,
    path: string,
    body?: string | Buffer
): Promise<Captured> => {
    const {req, url} = request(method, path, body);
    const {res, out} = response();
    await handler(req, res, url);
    return out;
};

describe('Router', () => {
    const router = new Router()
        .get('/api/notes/:id+/history', ({res, params}) => {
            res.writeHead(200).end(JSON.stringify({history: params.id}));
        })
        .get('/api/notes/:id+', ({res, params}) => {
            res.writeHead(200).end(JSON.stringify({id: params.id}));
        })
        .get('/api/jobs/:id', ({res, params}) => {
            res.writeHead(200).end(JSON.stringify({job: params.id}));
        })
        .get('/api/boom', () => {
            throw new HttpError(418, 'teapot');
        })
        .get('/api/crash', () => {
            throw new Error('kaputt');
        })
        .get('/api/stream', ({res}) => {
            res.writeHead(200);
            throw new Error('mid-stream');
        })
        .post('/api/body', async ({req, res}) => {
            const body = await readJsonBody(req);
            res.writeHead(200).end(JSON.stringify(body));
        });
    const handler = withErrorMapping(async (req, res, url) => {
        if (!(await router.dispatch(req, res, url))) res.writeHead(404).end('{"error":"not found"}');
    });

    it('decodes params, `:x+` spans slashes, more specific routes win', async () => {
        expect((await call(handler, 'GET', '/api/notes/Memory%2Fp%2Fa.md')).body).toEqual({id: 'Memory/p/a.md'});
        expect((await call(handler, 'GET', '/api/notes/Memory/p/a.md')).body).toEqual({id: 'Memory/p/a.md'});
        expect((await call(handler, 'GET', '/api/notes/a%20b.md/history')).body).toEqual({history: 'a b.md'});
        expect((await call(handler, 'GET', '/api/jobs/j1')).body).toEqual({job: 'j1'});
        expect((await call(handler, 'GET', '/api/jobs/j1/x')).status).toBe(404);
    });

    it('answers 405 for a known path with the wrong method, 404 for unknown paths', async () => {
        const wrong = await call(handler, 'DELETE', '/api/jobs/j1');
        expect(wrong.status).toBe(405);
        expect((await call(handler, 'GET', '/api/nope')).status).toBe(404);
    });

    it('maps errors centrally', async () => {
        expect(await call(handler, 'GET', '/api/boom')).toMatchObject({status: 418, body: {error: 'teapot'}});
        expect(await call(handler, 'GET', '/api/crash')).toMatchObject({status: 500, body: {error: 'kaputt'}});
        expect((await call(handler, 'GET', '/api/notes/%E0%A4%A')).status).toBe(400);
        expect((await call(handler, 'POST', '/api/body', '{oops')).status).toBe(400);
        expect((await call(handler, 'POST', '/api/body', '')).status).toBe(400);
        expect((await call(handler, 'POST', '/api/body', Buffer.alloc(JSON_BODY_LIMIT + 1, 32))).status).toBe(413);
        expect((await call(handler, 'POST', '/api/body', '{"a":1}')).body).toEqual({a: 1});
    });

    it('only ends a response whose headers already went out', async () => {
        const out = await call(handler, 'GET', '/api/stream');
        expect(out.status).toBe(200);
        expect(out.body).toBeUndefined();
    });
});

describe('pagination helpers', () => {
    const isId = (v: unknown): v is {id: string} => isRecord(v) && typeof v.id === 'string';

    it('round-trips cursors and rejects garbage with 400', () => {
        expect(decodeCursor(encodeCursor({id: 'a/b.md'}), isId)).toEqual({id: 'a/b.md'});
        expect(decodeCursor(null, isId)).toBeNull();
        expect(() => decodeCursor('not-json', isId)).toThrow(HttpError);
        expect(() => decodeCursor(encodeCursor({line: 3}), isId)).toThrow('invalid cursor');
    });

    it('pages by key with binary search, even if the cursor item is gone', () => {
        const items = ['a', 'b', 'c', 'd', 'e'];
        const id = (s: string): string => s;
        expect(keysetPage(items, id, null, 2)).toEqual({items: ['a', 'b'], nextKey: 'b'});
        expect(keysetPage(items, id, 'b', 2)).toEqual({items: ['c', 'd'], nextKey: 'd'});
        expect(keysetPage(items, id, 'd', 2)).toEqual({items: ['e'], nextKey: null});
        expect(keysetPage(items, id, 'bb', 10)).toEqual({items: ['c', 'd', 'e'], nextKey: null});
    });
});

describe('API routes', () => {
    const notes = ['c.md', 'Memory/p/a.md', 'a.md', 'Memory/p/b.md', 'b.md'].map((id) => ({
        id, title: id, tags: [], mtime: 1, frontmatter: {}
    }));
    const service = {
        listNotes: () => notes,
        graphVersion: () => 7,
        noteFlags: () => ({private: false}),
        noteHistory: async (id: string, limit: number) => [{id, limit}],
        getVault: () => ({tryGet: (id: string) => notes.find((n) => n.id === id)})
    } as unknown as SynaipseService;
    const handler = routes(service, {} as EventBroadcaster, {} as JobManager);

    it('keeps the full array without paging params', async () => {
        const out = await call(handler, 'GET', '/api/notes');
        expect(out.headers['X-Synaipse-Version']).toBe('7');
        expect(Array.isArray(out.body)).toBe(true);
        expect(out.body).toHaveLength(5);
    });

    it('pages /api/notes by id with an opaque cursor and an optional prefix', async () => {
        const ids: string[] = [];
        let cursor: string | null = null;
        let pages = 0;

        do {
            const q: string = cursor === null ? '' : `&cursor=${cursor}`;
            const out = await call(handler, 'GET', `/api/notes?limit=2${q}`);
            const body = out.body as {notes: Array<{id: string}>; nextCursor: string | null; total: number};
            expect(body.total).toBe(5);
            ids.push(...body.notes.map((n) => n.id));
            cursor = body.nextCursor;
            pages++;
        } while (cursor !== null);

        expect(pages).toBe(3);
        expect(ids).toEqual(['Memory/p/a.md', 'Memory/p/b.md', 'a.md', 'b.md', 'c.md']);

        const scoped = (await call(handler, 'GET', '/api/notes?limit=10&prefix=Memory/')).body as {notes: unknown[]; total: number};
        expect(scoped.total).toBe(2);
        expect((await call(handler, 'GET', '/api/notes?cursor=zzz')).status).toBe(400);
    });

    it('routes note sub-resources and clamps limits', async () => {
        const out = await call(handler, 'GET', '/api/notes/Memory%2Fp%2Fa.md/history?limit=99999');
        expect(out.body).toEqual({entries: [{id: 'Memory/p/a.md', limit: 500}]});
        expect((await call(handler, 'GET', '/api/notes/missing.md')).status).toBe(404);
        expect((await call(handler, 'POST', '/api/notes/a.md')).status).toBe(405);
        expect((await call(handler, 'GET', '/api/does-not-exist')).status).toBe(404);
    });
});
