import {describe, it, expect, beforeEach} from 'vitest';
import {IncomingMessage, ServerResponse} from 'node:http';
import {Socket} from 'node:net';
import {InMemoryAccountStore} from '../../mcp-server/test/InMemoryAccountStore.js';
import {handleAuthRoute, type AuthContext} from '../server/auth-routes.js';
import {InMemorySessionStore, SESSION_COOKIE_NAME} from '../server/sessions.js';
import {LoginRateLimit} from '../server/login-rate-limit.js';

const makeReq = (opts: {method?: string; path: string; cookie?: string; body?: unknown; ip?: string}): IncomingMessage => {
    const socket = new Socket();
    Object.defineProperty(socket, 'remoteAddress', {value: opts.ip ?? '127.0.0.1', configurable: true});
    const req = new IncomingMessage(socket);
    req.method = opts.method ?? 'GET';
    req.url = opts.path;
    if (opts.cookie !== undefined) req.headers.cookie = opts.cookie;

    if (opts.body !== undefined) {
        const payload = Buffer.from(JSON.stringify(opts.body), 'utf8');
        // Drive the async-iterator path used by readJson
        queueMicrotask(() => {
            req.push(payload);
            req.push(null);
        });
    } else {
        queueMicrotask(() => req.push(null));
    }

    return req;
};

interface CapturedResponse {
    status: number;
    body: unknown;
    headers: Record<string, string | string[]>;
}

const makeRes = (): {res: ServerResponse; captured: CapturedResponse} => {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    const res = new ServerResponse(req);

    const captured: CapturedResponse = {status: 0, body: undefined, headers: {}};
    const chunks: Buffer[] = [];

    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = ((status: number, headers?: Record<string, string | string[]>) => {
        captured.status = status;
        if (headers !== undefined) captured.headers = {...captured.headers, ...headers};
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
let sessions: InMemorySessionStore;
let auth: AuthContext;

beforeEach(() => {
    accounts = new InMemoryAccountStore();
    sessions = new InMemorySessionStore();
    auth = {
        sessions,
        accounts,
        rateLimit: new LoginRateLimit({maxAttempts: 3, windowMs: 60_000}),
        secureCookie: false
    };
});

const runAuth = async (
    reqOpts: Parameters<typeof makeReq>[0],
    mode: 'local' | 'server' = 'server',
    authCtx: AuthContext | null = auth
) => {
    const req = makeReq(reqOpts);
    const {res, captured} = makeRes();
    const url = new URL(`http://localhost${reqOpts.path}`);
    const result = await handleAuthRoute(req, res, url, mode, authCtx);
    return {result, captured};
};

describe('GET /api/auth/mode', () => {
    it('returns local in local-mode', async () => {
        const {result, captured} = await runAuth({path: '/api/auth/mode'}, 'local', null);
        expect(result.handled).toBe(true);
        expect(captured.status).toBe(200);
        expect(captured.body).toEqual({mode: 'local', authenticated: true});
    });

    it('returns server+unauthenticated when no session cookie present', async () => {
        const {captured} = await runAuth({path: '/api/auth/mode'});
        expect(captured.status).toBe(200);
        expect(captured.body).toEqual({mode: 'server', authenticated: false});
    });

    it('returns server+authenticated when session resolves to an account', async () => {
        const a = await accounts.create({email: 'me@example.com', password: 'pw'});
        const s = sessions.create(a.id);
        const {captured} = await runAuth({path: '/api/auth/mode', cookie: `${SESSION_COOKIE_NAME}=${s.id}`});
        expect(captured.status).toBe(200);
        const body = captured.body as {mode: string; authenticated: boolean; account: {email: string}};
        expect(body.mode).toBe('server');
        expect(body.authenticated).toBe(true);
        expect(body.account.email).toBe('me@example.com');
    });

    it('does not expose password material on the wire', async () => {
        const a = await accounts.create({email: 'me@example.com', password: 'secret-pw'});
        const s = sessions.create(a.id);
        const {captured} = await runAuth({path: '/api/auth/mode', cookie: `${SESSION_COOKIE_NAME}=${s.id}`});
        expect(JSON.stringify(captured.body)).not.toContain('secret-pw');
        expect(JSON.stringify(captured.body)).not.toContain('hashHex');
        expect(JSON.stringify(captured.body)).not.toContain('password');
    });

    it('returns 405 for non-GET methods', async () => {
        const {captured} = await runAuth({method: 'POST', path: '/api/auth/mode'});
        expect(captured.status).toBe(405);
    });
});

describe('POST /api/auth/login', () => {
    it('returns 200 + sets cookie on valid credentials', async () => {
        await accounts.create({email: 'me@example.com', password: 'pw'});
        const {captured} = await runAuth({
            method: 'POST',
            path: '/api/auth/login',
            body: {email: 'me@example.com', password: 'pw'}
        });
        expect(captured.status).toBe(200);
        const cookie = captured.headers['Set-Cookie'];
        expect(cookie).toBeDefined();
        expect(String(cookie)).toContain(SESSION_COOKIE_NAME + '=');
        expect(String(cookie)).toContain('HttpOnly');
        expect(String(cookie)).toContain('SameSite=Strict');
    });

    it('returns 401 on wrong password (no enumeration oracle)', async () => {
        await accounts.create({email: 'me@example.com', password: 'pw'});
        const {captured} = await runAuth({
            method: 'POST',
            path: '/api/auth/login',
            body: {email: 'me@example.com', password: 'wrong'}
        });
        expect(captured.status).toBe(401);
        expect(captured.headers['Set-Cookie']).toBeUndefined();
    });

    it('returns 401 on unknown email (same response as wrong password)', async () => {
        const {captured} = await runAuth({
            method: 'POST',
            path: '/api/auth/login',
            body: {email: 'ghost@nowhere.com', password: 'pw'}
        });
        expect(captured.status).toBe(401);
    });

    it('returns 401 on disabled account', async () => {
        const a = await accounts.create({email: 'me@example.com', password: 'pw'});
        await accounts.setDisabled(a.id, true);
        const {captured} = await runAuth({
            method: 'POST',
            path: '/api/auth/login',
            body: {email: 'me@example.com', password: 'pw'}
        });
        expect(captured.status).toBe(401);
    });

    it('returns 400 when body is missing or malformed', async () => {
        const {captured: c1} = await runAuth({
            method: 'POST',
            path: '/api/auth/login',
            body: {email: '', password: 'pw'}
        });
        expect(c1.status).toBe(400);
    });

    it('returns 429 after exceeding the rate limit', async () => {
        await accounts.create({email: 'me@example.com', password: 'pw'});
        // 3 attempts allowed in fresh rate limit
        for (let i = 0; i < 3; i++) {
            await runAuth({
                method: 'POST',
                path: '/api/auth/login',
                body: {email: 'me@example.com', password: 'wrong'}
            });
        }
        const {captured} = await runAuth({
            method: 'POST',
            path: '/api/auth/login',
            body: {email: 'me@example.com', password: 'pw'}  // even valid creds get throttled
        });
        expect(captured.status).toBe(429);
    });

    it('returns 404 in local-mode (login is not a thing without accounts)', async () => {
        const {captured} = await runAuth(
            {method: 'POST', path: '/api/auth/login', body: {email: 'x', password: 'y'}},
            'local',
            null
        );
        expect(captured.status).toBe(404);
    });
});

describe('POST /api/auth/logout', () => {
    it('clears the cookie and revokes the session', async () => {
        const a = await accounts.create({email: 'me@example.com', password: 'pw'});
        const s = sessions.create(a.id);
        const {captured} = await runAuth({
            method: 'POST',
            path: '/api/auth/logout',
            cookie: `${SESSION_COOKIE_NAME}=${s.id}`
        });
        expect(captured.status).toBe(200);
        expect(String(captured.headers['Set-Cookie'])).toContain(SESSION_COOKIE_NAME + '=');
        expect(sessions.get(s.id)).toBeNull();
    });

    it('is idempotent (200 even without a session)', async () => {
        const {captured} = await runAuth({method: 'POST', path: '/api/auth/logout'});
        expect(captured.status).toBe(200);
    });
});

describe('GET /api/auth/me', () => {
    it('returns 401 when not authenticated', async () => {
        const {captured} = await runAuth({path: '/api/auth/me'});
        expect(captured.status).toBe(401);
    });

    it('returns the current account when authenticated', async () => {
        const a = await accounts.create({email: 'me@example.com', password: 'pw'});
        const s = sessions.create(a.id);
        const {captured} = await runAuth({
            path: '/api/auth/me',
            cookie: `${SESSION_COOKIE_NAME}=${s.id}`
        });
        expect(captured.status).toBe(200);
        const body = captured.body as {mode: string; account: {email: string}};
        expect(body.mode).toBe('server');
        expect(body.account.email).toBe('me@example.com');
    });

    it('returns 200 + null account in local-mode (not 401)', async () => {
        const {captured} = await runAuth({path: '/api/auth/me'}, 'local', null);
        expect(captured.status).toBe(200);
        expect(captured.body).toEqual({mode: 'local', account: null});
    });

    it('revokes the session when the account was deleted out from under it', async () => {
        const a = await accounts.create({email: 'me@example.com', password: 'pw'});
        const s = sessions.create(a.id);
        // Wipe accounts: a fresh store has no rows.
        accounts = new InMemoryAccountStore();
        auth = {...auth, accounts};
        const {captured} = await runAuth({
            path: '/api/auth/me',
            cookie: `${SESSION_COOKIE_NAME}=${s.id}`
        }, 'server', auth);
        expect(captured.status).toBe(401);
        expect(sessions.get(s.id)).toBeNull();
    });
});

describe('unknown auth paths fall through', () => {
    it('returns handled=false for non-auth paths', async () => {
        const {result} = await runAuth({path: '/api/notes'});
        expect(result.handled).toBe(false);
    });
});