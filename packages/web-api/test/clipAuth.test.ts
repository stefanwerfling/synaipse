import {describe, it, expect, beforeEach} from 'vitest';
import {IncomingMessage, ServerResponse} from 'node:http';
import {Socket} from 'node:net';
import type {Config} from '@synaipse/core';
import type {SynaipseService} from '@synaipse/service';
import type {EventBroadcaster} from '../server/events.js';
import type {JobManager} from '../server/jobs.js';
import {routes} from '../server/routes.js';

const makeReq = (opts: {
    method?: string;
    path: string;
    body?: unknown;
    auth?: string;
}): IncomingMessage => {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = opts.method ?? 'POST';
    req.url = opts.path;
    if (opts.auth !== undefined) req.headers.authorization = opts.auth;

    if (opts.body !== undefined) {
        const payload = Buffer.from(JSON.stringify(opts.body), 'utf8');
        req.headers['content-length'] = String(payload.length);
        req.headers['content-type'] = 'application/json';
        queueMicrotask(() => {
            req.push(payload);
            req.push(null);
        });
    } else {
        queueMicrotask(() => req.push(null));
    }

    return req;
};

interface Captured {
    status: number;
    body: unknown;
}

const makeRes = (): {res: ServerResponse; captured: Captured} => {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    const res = new ServerResponse(req);
    const captured: Captured = {status: 0, body: undefined};
    const chunks: Buffer[] = [];

    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = ((status: number, headers?: Record<string, string | string[]>) => {
        captured.status = status;
        return origWriteHead(status, headers);
    }) as typeof res.writeHead;

    const origEnd = res.end.bind(res);
    res.end = ((chunk?: unknown) => {
        if (chunk !== undefined && chunk !== null) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer);
        }
        try {
            captured.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            captured.body = Buffer.concat(chunks).toString('utf8');
        }
        return origEnd();
    }) as typeof res.end;

    return {res, captured};
};

let clipCalls: Array<{url: string; title: string}> = [];

const makeService = (): SynaipseService => {
    const stub = {
        clipPage: async (input: {url: string; title: string}) => {
            clipCalls.push({url: input.url, title: input.title});
            return {noteId: 'Clipped/stub.md' as unknown as string, isUpdate: false};
        }
    };
    return stub as unknown as SynaipseService;
};

const stubBroadcaster = {publish: () => undefined} as unknown as EventBroadcaster;
const stubJobs = {
    listJobs: () => [],
    getJob: () => undefined,
    startJob: async () => 'stub',
    cancelJob: () => false
} as unknown as JobManager;

const invoke = async (
    opts: Parameters<typeof makeReq>[0],
    config: Config | undefined
) => {
    const handle = routes(makeService(), stubBroadcaster, stubJobs, {
        mode: 'local',
        auth: null,
        userStore: null,
        ...(config !== undefined ? {config} : {})
    });
    const req = makeReq(opts);
    const {res, captured} = makeRes();
    const url = new URL(`http://localhost${opts.path}`);
    await handle(req, res, url);
    return captured;
};

const configWithToken = (token: string): Config => ({
    server: {token}
} as unknown as Config);

const configWithGranular = (tokens: Array<{
    token: string;
    label?: string;
    read?: boolean;
    write?: boolean;
    pathPrefixes?: readonly string[];
    tools?: readonly string[];
}>): Config => ({
    server: {tokens}
} as unknown as Config);

const configEmpty = (): Config => ({server: {}} as unknown as Config);

const validBody = {
    url: 'https://example.com/post',
    title: 'Example',
    markdown: '# Example\n\ncontent'
};

describe('POST /api/clip bearer auth', () => {
    beforeEach(() => {
        clipCalls = [];
    });

    it('accepts anonymous when no config is passed (test convenience)', async () => {
        const captured = await invoke({path: '/api/clip', body: validBody}, undefined);
        expect(captured.status).toBe(200);
        expect(clipCalls).toHaveLength(1);
    });

    it('accepts anonymous when config has no tokens configured', async () => {
        const captured = await invoke({path: '/api/clip', body: validBody}, configEmpty());
        expect(captured.status).toBe(200);
        expect(clipCalls).toHaveLength(1);
    });

    it('rejects missing bearer when a legacy admin token is configured', async () => {
        const captured = await invoke(
            {path: '/api/clip', body: validBody},
            configWithToken('admin-secret')
        );
        expect(captured.status).toBe(401);
        expect(clipCalls).toHaveLength(0);
    });

    it('rejects a bearer that does not match any configured token', async () => {
        const captured = await invoke(
            {path: '/api/clip', body: validBody, auth: 'Bearer wrong'},
            configWithToken('admin-secret')
        );
        expect(captured.status).toBe(401);
        expect(clipCalls).toHaveLength(0);
    });

    it('accepts the matching legacy admin token', async () => {
        const captured = await invoke(
            {path: '/api/clip', body: validBody, auth: 'Bearer admin-secret'},
            configWithToken('admin-secret')
        );
        expect(captured.status).toBe(200);
        expect(clipCalls).toHaveLength(1);
    });

    it('rejects a read-only granular token with 403', async () => {
        const captured = await invoke(
            {path: '/api/clip', body: validBody, auth: 'Bearer ro-token'},
            configWithGranular([{token: 'ro-token', read: true, write: false, label: 'reader'}])
        );
        expect(captured.status).toBe(403);
        expect(clipCalls).toHaveLength(0);
    });

    it('accepts a write-scoped granular token without path restriction', async () => {
        const captured = await invoke(
            {path: '/api/clip', body: validBody, auth: 'Bearer rw-token'},
            configWithGranular([{token: 'rw-token', read: true, write: true, label: 'clipper'}])
        );
        expect(captured.status).toBe(200);
        expect(clipCalls).toHaveLength(1);
    });

    it('accepts a token whose path prefix covers Clipped/', async () => {
        const captured = await invoke(
            {path: '/api/clip', body: validBody, auth: 'Bearer scoped'},
            configWithGranular([{
                token: 'scoped',
                read: true,
                write: true,
                pathPrefixes: ['Clipped/']
            }])
        );
        expect(captured.status).toBe(200);
        expect(clipCalls).toHaveLength(1);
    });

    it('rejects a token whose path prefix excludes Clipped/', async () => {
        const captured = await invoke(
            {path: '/api/clip', body: validBody, auth: 'Bearer scoped'},
            configWithGranular([{
                token: 'scoped',
                read: true,
                write: true,
                pathPrefixes: ['Research/']
            }])
        );
        expect(captured.status).toBe(403);
        expect(clipCalls).toHaveLength(0);
    });
});

describe('OPTIONS /api/clip', () => {
    it('advertises Authorization in Access-Control-Allow-Headers', async () => {
        const handle = routes(makeService(), stubBroadcaster, stubJobs, {mode: 'local', auth: null});
        const req = makeReq({method: 'OPTIONS', path: '/api/clip'});
        const {res, captured} = makeRes();

        const seen: Record<string, string> = {};
        const origSet = res.setHeader.bind(res);
        res.setHeader = ((name: string, value: string) => {
            seen[name] = value;
            return origSet(name, value);
        }) as typeof res.setHeader;

        await handle(req, res, new URL('http://localhost/api/clip'));
        expect(captured.status).toBe(204);
        expect(seen['Access-Control-Allow-Headers']).toContain('Authorization');
    });
});