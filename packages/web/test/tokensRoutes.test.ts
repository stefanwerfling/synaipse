import {describe, it, expect, beforeEach} from 'vitest';
import {IncomingMessage, ServerResponse} from 'node:http';
import {Socket} from 'node:net';
import {InMemoryAccountStore} from '../../mcp-server/test/InMemoryAccountStore.js';
import {InMemoryUserStore} from '../../mcp-server/test/InMemoryUserStore.js';
import {type AuthContext} from '../server/auth-routes.js';
import {InMemorySessionStore, SESSION_COOKIE_NAME} from '../server/sessions.js';
import {LoginRateLimit} from '../server/login-rate-limit.js';
import {handleTokensRoute} from '../server/tokens-routes.js';

const makeReq = (opts: {method?: string; path: string; cookie?: string; body?: unknown}): IncomingMessage => {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = opts.method ?? 'GET';
    req.url = opts.path;
    if (opts.cookie !== undefined) req.headers.cookie = opts.cookie;

    if (opts.body !== undefined) {
        const payload = Buffer.from(JSON.stringify(opts.body), 'utf8');
        req.headers['content-length'] = String(payload.length);
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

let accounts: InMemoryAccountStore;
let users: InMemoryUserStore;
let sessions: InMemorySessionStore;
let auth: AuthContext;

const runTokens = async (
    reqOpts: Parameters<typeof makeReq>[0],
    mode: 'local' | 'server' = 'server',
    authCtx: AuthContext | null = auth
) => {
    const req = makeReq(reqOpts);
    const {res, captured} = makeRes();
    const url = new URL(`http://localhost${reqOpts.path}`);
    const result = await handleTokensRoute(
        req, res, url, mode, authCtx,
        async () => users
    );
    return {result, captured};
};

beforeEach(() => {
    accounts = new InMemoryAccountStore();
    users = new InMemoryUserStore();
    sessions = new InMemorySessionStore();
    auth = {
        sessions,
        accounts,
        rateLimit: new LoginRateLimit(),
        secureCookie: false
    };
});

const loginAs = async (email: string): Promise<{accountId: number; cookie: string}> => {
    const account = await accounts.create({email, password: 'pw'});
    const session = sessions.create(account.id);
    return {accountId: account.id, cookie: `${SESSION_COOKIE_NAME}=${session.id}`};
};

describe('GET /api/tokens', () => {
    it('returns 404 in local-mode (no accounts there)', async () => {
        const {result, captured} = await runTokens({path: '/api/tokens'}, 'local', null);
        expect(result.handled).toBe(true);
        expect(captured.status).toBe(404);
    });

    it('returns 401 without a session', async () => {
        const {captured} = await runTokens({path: '/api/tokens'});
        expect(captured.status).toBe(401);
    });

    it('lists ONLY the current account tokens, never others', async () => {
        const me = await loginAs('me@example.com');
        const other = await accounts.create({email: 'other@example.com', password: 'pw'});

        await users.createUser({label: 'mine', read: true, write: false, accountId: me.accountId});
        await users.createUser({label: 'theirs', read: true, write: false, accountId: other.id});
        await users.createUser({label: 'service', read: true, write: false});  // no accountId

        const {captured} = await runTokens({path: '/api/tokens', cookie: me.cookie});
        expect(captured.status).toBe(200);
        const body = captured.body as {tokens: Array<{label: string}>};
        expect(body.tokens.map((t) => t.label)).toEqual(['mine']);
    });

    it('does not include the bearer hash/salt in the response', async () => {
        const me = await loginAs('me@example.com');
        await users.createUser({label: 'mine', read: true, write: false, accountId: me.accountId});

        const {captured} = await runTokens({path: '/api/tokens', cookie: me.cookie});
        const serialized = JSON.stringify(captured.body);
        expect(serialized).not.toContain('hashHex');
        expect(serialized).not.toContain('saltHex');
        expect(serialized).not.toContain('plainToken');
    });
});

describe('POST /api/tokens', () => {
    it('creates a token + returns the plain bearer once', async () => {
        const me = await loginAs('me@example.com');
        const {captured} = await runTokens({
            method: 'POST', path: '/api/tokens', cookie: me.cookie,
            body: {label: 'cli-laptop', read: true, write: true}
        });
        expect(captured.status).toBe(200);
        const body = captured.body as {token: {label: string; tokenHint: string}; plainToken: string};
        expect(body.token.label).toBe('cli-laptop');
        expect(body.plainToken).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(body.plainToken.length).toBeGreaterThan(20);
    });

    it('subsequent GET /api/tokens returns the created row scoped to me', async () => {
        const me = await loginAs('me@example.com');
        await runTokens({
            method: 'POST', path: '/api/tokens', cookie: me.cookie,
            body: {label: 'foo', read: true, write: false}
        });
        const {captured} = await runTokens({path: '/api/tokens', cookie: me.cookie});
        const body = captured.body as {tokens: Array<{label: string}>};
        expect(body.tokens.map((t) => t.label)).toEqual(['foo']);
    });

    it('rejects label with disallowed characters', async () => {
        const me = await loginAs('me@example.com');
        const {captured} = await runTokens({
            method: 'POST', path: '/api/tokens', cookie: me.cookie,
            body: {label: 'bad$label', read: true, write: false}
        });
        expect(captured.status).toBe(400);
    });

    it('rejects when neither read nor write is true', async () => {
        const me = await loginAs('me@example.com');
        const {captured} = await runTokens({
            method: 'POST', path: '/api/tokens', cookie: me.cookie,
            body: {label: 'no-scope', read: false, write: false}
        });
        expect(captured.status).toBe(400);
    });

    it('rejects expiresInDays <= 0 or too large', async () => {
        const me = await loginAs('me@example.com');
        const {captured: c1} = await runTokens({
            method: 'POST', path: '/api/tokens', cookie: me.cookie,
            body: {label: 'x', read: true, write: false, expiresInDays: -1}
        });
        expect(c1.status).toBe(400);

        const {captured: c2} = await runTokens({
            method: 'POST', path: '/api/tokens', cookie: me.cookie,
            body: {label: 'x', read: true, write: false, expiresInDays: 999_999}
        });
        expect(c2.status).toBe(400);
    });

    it('accepts a valid expiresInDays and stamps expiresAt', async () => {
        const me = await loginAs('me@example.com');
        const before = Date.now();
        const {captured} = await runTokens({
            method: 'POST', path: '/api/tokens', cookie: me.cookie,
            body: {label: 'short', read: true, write: false, expiresInDays: 7}
        });
        const body = captured.body as {token: {expiresAt: number}};
        const expected = before + 7 * 86_400_000;
        expect(body.token.expiresAt).toBeGreaterThanOrEqual(expected - 1000);
        expect(body.token.expiresAt).toBeLessThanOrEqual(expected + 5000);
    });
});

describe('DELETE /api/tokens/:id', () => {
    it('revokes the current users own token', async () => {
        const me = await loginAs('me@example.com');
        const created = await users.createUser({label: 'mine', read: true, write: false, accountId: me.accountId});

        const {captured} = await runTokens({
            method: 'DELETE',
            path: `/api/tokens/${created.user.id}`,
            cookie: me.cookie
        });
        expect(captured.status).toBe(200);

        const list = await users.listByAccount(me.accountId);
        expect(list[0]?.revokedAt).not.toBeNull();
    });

    it('refuses to revoke another accounts token (404, not 403, to avoid leaking existence)', async () => {
        const me = await loginAs('me@example.com');
        const other = await accounts.create({email: 'other@example.com', password: 'pw'});
        const theirs = await users.createUser({label: 't', read: true, write: false, accountId: other.id});

        const {captured} = await runTokens({
            method: 'DELETE',
            path: `/api/tokens/${theirs.user.id}`,
            cookie: me.cookie
        });
        expect(captured.status).toBe(404);
    });

    it('refuses to revoke service tokens (account_id IS NULL)', async () => {
        const me = await loginAs('me@example.com');
        const svc = await users.createUser({label: 'svc', read: true, write: false});

        const {captured} = await runTokens({
            method: 'DELETE',
            path: `/api/tokens/${svc.user.id}`,
            cookie: me.cookie
        });
        expect(captured.status).toBe(404);
    });
});

describe('POST /api/tokens/:id/rotate', () => {
    it('rotates the current users own token and returns the new bearer once', async () => {
        const me = await loginAs('me@example.com');
        const created = await users.createUser({label: 'mine', read: true, write: false, accountId: me.accountId});
        const oldHint = created.user.tokenHint;

        const {captured} = await runTokens({
            method: 'POST',
            path: `/api/tokens/${created.user.id}/rotate`,
            cookie: me.cookie
        });
        expect(captured.status).toBe(200);
        const body = captured.body as {token: {tokenHint: string}; plainToken: string};
        expect(body.token.tokenHint).not.toBe(oldHint);
        expect(body.plainToken.length).toBeGreaterThan(20);
    });

    it('returns 404 when trying to rotate another accounts token', async () => {
        const me = await loginAs('me@example.com');
        const other = await accounts.create({email: 'other@example.com', password: 'pw'});
        const theirs = await users.createUser({label: 't', read: true, write: false, accountId: other.id});

        const {captured} = await runTokens({
            method: 'POST',
            path: `/api/tokens/${theirs.user.id}/rotate`,
            cookie: me.cookie
        });
        expect(captured.status).toBe(404);
    });
});

describe('method-not-allowed cases', () => {
    it('PUT /api/tokens → 405', async () => {
        const me = await loginAs('me@example.com');
        const {captured} = await runTokens({method: 'PUT', path: '/api/tokens', cookie: me.cookie});
        expect(captured.status).toBe(405);
    });

    it('GET /api/tokens/:id/rotate → 405', async () => {
        const me = await loginAs('me@example.com');
        const {captured} = await runTokens({method: 'GET', path: '/api/tokens/1/rotate', cookie: me.cookie});
        expect(captured.status).toBe(405);
    });
});