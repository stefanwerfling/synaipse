import {describe, it, expect, beforeEach} from 'vitest';
import {IncomingMessage, ServerResponse} from 'node:http';
import {Socket} from 'node:net';
import {InMemoryAccountStore} from '../../mcp-server/test/InMemoryAccountStore.js';
import {type AuthContext} from '../server/auth-routes.js';
import {InMemorySessionStore, SESSION_COOKIE_NAME} from '../server/sessions.js';
import {LoginRateLimit} from '../server/login-rate-limit.js';
import {handleAdminRoute} from '../server/admin-routes.js';

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
let sessions: InMemorySessionStore;
let auth: AuthContext;

const runAdmin = async (
    reqOpts: Parameters<typeof makeReq>[0],
    mode: 'local' | 'server' = 'server',
    authCtx: AuthContext | null = auth
) => {
    const req = makeReq(reqOpts);
    const {res, captured} = makeRes();
    const url = new URL(`http://localhost${reqOpts.path}`);
    const result = await handleAdminRoute(req, res, url, mode, authCtx);
    return {result, captured};
};

beforeEach(() => {
    accounts = new InMemoryAccountStore();
    sessions = new InMemorySessionStore();
    auth = {
        sessions,
        accounts,
        rateLimit: new LoginRateLimit(),
        secureCookie: false
    };
});

const loginAs = async (email: string, isAdmin: boolean): Promise<{accountId: number; cookie: string}> => {
    const account = await accounts.create({email, password: 'pw-strong-12', isAdmin});
    const session = sessions.create(account.id);
    return {accountId: account.id, cookie: `${SESSION_COOKIE_NAME}=${session.id}`};
};

describe('admin gate', () => {
    it('returns 404 in local-mode', async () => {
        const {result, captured} = await runAdmin({path: '/api/admin/users'}, 'local', null);
        expect(result.handled).toBe(true);
        expect(captured.status).toBe(404);
    });

    it('returns 401 without a session', async () => {
        const {captured} = await runAdmin({path: '/api/admin/users'});
        expect(captured.status).toBe(401);
    });

    it('returns 403 for a logged-in non-admin', async () => {
        const peon = await loginAs('peon@example.com', false);
        const {captured} = await runAdmin({path: '/api/admin/users', cookie: peon.cookie});
        expect(captured.status).toBe(403);
    });

    it('non-admin cannot even create users', async () => {
        const peon = await loginAs('peon@example.com', false);
        const {captured} = await runAdmin({
            method: 'POST', path: '/api/admin/users', cookie: peon.cookie,
            body: {email: 'new@example.com', password: 'pw-strong-12', isAdmin: false}
        });
        expect(captured.status).toBe(403);
    });
});

describe('GET /api/admin/users', () => {
    it('lists every account in the vault', async () => {
        const admin = await loginAs('admin@example.com', true);
        await accounts.create({email: 'a@x.com', password: 'pw-strong-12'});
        await accounts.create({email: 'b@x.com', password: 'pw-strong-12', isAdmin: true});

        const {captured} = await runAdmin({path: '/api/admin/users', cookie: admin.cookie});
        expect(captured.status).toBe(200);
        const body = captured.body as {accounts: Array<{email: string; isAdmin: boolean}>};
        expect(body.accounts.map((a) => a.email).sort()).toEqual(['a@x.com', 'admin@example.com', 'b@x.com']);
    });

    it('does not include hashHex or saltHex in the response', async () => {
        const admin = await loginAs('admin@example.com', true);
        const {captured} = await runAdmin({path: '/api/admin/users', cookie: admin.cookie});
        const serialized = JSON.stringify(captured.body);
        expect(serialized).not.toContain('hashHex');
        expect(serialized).not.toContain('saltHex');
        expect(serialized).not.toContain('password');
    });
});

describe('POST /api/admin/users', () => {
    it('creates a new non-admin account', async () => {
        const admin = await loginAs('admin@example.com', true);
        const {captured} = await runAdmin({
            method: 'POST', path: '/api/admin/users', cookie: admin.cookie,
            body: {email: 'new@example.com', password: 'pw-strong-12'}
        });
        expect(captured.status).toBe(200);
        const body = captured.body as {account: {email: string; isAdmin: boolean}};
        expect(body.account.email).toBe('new@example.com');
        expect(body.account.isAdmin).toBe(false);
    });

    it('creates an admin when isAdmin:true', async () => {
        const admin = await loginAs('admin@example.com', true);
        const {captured} = await runAdmin({
            method: 'POST', path: '/api/admin/users', cookie: admin.cookie,
            body: {email: 'admin2@example.com', password: 'pw-strong-12', isAdmin: true}
        });
        const body = captured.body as {account: {isAdmin: boolean}};
        expect(body.account.isAdmin).toBe(true);
    });

    it('lower-cases the email for storage', async () => {
        const admin = await loginAs('admin@example.com', true);
        const {captured} = await runAdmin({
            method: 'POST', path: '/api/admin/users', cookie: admin.cookie,
            body: {email: 'MiXeD@CaSe.COM', password: 'pw-strong-12'}
        });
        const body = captured.body as {account: {email: string}};
        expect(body.account.email).toBe('mixed@case.com');
    });

    it('rejects malformed email', async () => {
        const admin = await loginAs('admin@example.com', true);
        const {captured} = await runAdmin({
            method: 'POST', path: '/api/admin/users', cookie: admin.cookie,
            body: {email: 'not-an-email', password: 'pw-strong-12'}
        });
        expect(captured.status).toBe(400);
    });

    it('rejects too-short password', async () => {
        const admin = await loginAs('admin@example.com', true);
        const {captured} = await runAdmin({
            method: 'POST', path: '/api/admin/users', cookie: admin.cookie,
            body: {email: 'new@example.com', password: 'short'}
        });
        expect(captured.status).toBe(400);
    });

    it('409 on duplicate email', async () => {
        const admin = await loginAs('admin@example.com', true);
        await accounts.create({email: 'taken@example.com', password: 'pw-strong-12'});
        const {captured} = await runAdmin({
            method: 'POST', path: '/api/admin/users', cookie: admin.cookie,
            body: {email: 'taken@example.com', password: 'pw-strong-12'}
        });
        expect(captured.status).toBe(409);
    });
});

describe('PATCH /api/admin/users/:id', () => {
    it('disables another user and revokes their active sessions', async () => {
        const admin = await loginAs('admin@example.com', true);
        const victim = await loginAs('victim@example.com', false);

        // Sanity: victim has an active session
        expect(sessions.get(victim.cookie.split('=')[1] as string)).not.toBeNull();

        const {captured} = await runAdmin({
            method: 'PATCH', path: `/api/admin/users/${victim.accountId}`, cookie: admin.cookie,
            body: {disabled: true}
        });
        expect(captured.status).toBe(200);
        const body = captured.body as {account: {disabledAt: number | null}};
        expect(body.account.disabledAt).not.toBeNull();

        // Session must be gone immediately, not later
        expect(sessions.get(victim.cookie.split('=')[1] as string)).toBeNull();
    });

    it('re-enables a previously disabled user', async () => {
        const admin = await loginAs('admin@example.com', true);
        const target = await accounts.create({email: 'target@example.com', password: 'pw-strong-12'});
        await accounts.setDisabled(target.id, true);

        const {captured} = await runAdmin({
            method: 'PATCH', path: `/api/admin/users/${target.id}`, cookie: admin.cookie,
            body: {disabled: false}
        });
        expect(captured.status).toBe(200);
        const body = captured.body as {account: {disabledAt: number | null}};
        expect(body.account.disabledAt).toBeNull();
    });

    it('promotes a regular user to admin', async () => {
        const admin = await loginAs('admin@example.com', true);
        const target = await accounts.create({email: 'rookie@example.com', password: 'pw-strong-12'});

        const {captured} = await runAdmin({
            method: 'PATCH', path: `/api/admin/users/${target.id}`, cookie: admin.cookie,
            body: {isAdmin: true}
        });
        const body = captured.body as {account: {isAdmin: boolean}};
        expect(body.account.isAdmin).toBe(true);
    });

    it('resets another users password and the old password no longer logs in', async () => {
        const admin = await loginAs('admin@example.com', true);
        const target = await accounts.create({email: 'target@example.com', password: 'pw-strong-12'});

        // Old password verifies
        expect(await accounts.verifyLogin('target@example.com', 'pw-strong-12')).not.toBeNull();

        const {captured} = await runAdmin({
            method: 'PATCH', path: `/api/admin/users/${target.id}`, cookie: admin.cookie,
            body: {password: 'brand-new-22'}
        });
        expect(captured.status).toBe(200);

        expect(await accounts.verifyLogin('target@example.com', 'pw-strong-12')).toBeNull();
        expect(await accounts.verifyLogin('target@example.com', 'brand-new-22')).not.toBeNull();
    });

    it('refuses to disable yourself', async () => {
        const admin = await loginAs('admin@example.com', true);
        const {captured} = await runAdmin({
            method: 'PATCH', path: `/api/admin/users/${admin.accountId}`, cookie: admin.cookie,
            body: {disabled: true}
        });
        expect(captured.status).toBe(400);
    });

    it('refuses to revoke your own admin', async () => {
        const admin = await loginAs('admin@example.com', true);
        const {captured} = await runAdmin({
            method: 'PATCH', path: `/api/admin/users/${admin.accountId}`, cookie: admin.cookie,
            body: {isAdmin: false}
        });
        expect(captured.status).toBe(400);
    });

    it('allows changing your own password', async () => {
        const admin = await loginAs('admin@example.com', true);
        const {captured} = await runAdmin({
            method: 'PATCH', path: `/api/admin/users/${admin.accountId}`, cookie: admin.cookie,
            body: {password: 'rotated-12'}
        });
        expect(captured.status).toBe(200);
        expect(await accounts.verifyLogin('admin@example.com', 'rotated-12')).not.toBeNull();
    });

    it('404 for unknown user id', async () => {
        const admin = await loginAs('admin@example.com', true);
        const {captured} = await runAdmin({
            method: 'PATCH', path: '/api/admin/users/9999', cookie: admin.cookie,
            body: {disabled: true}
        });
        expect(captured.status).toBe(404);
    });

    it('400 when patch body is empty', async () => {
        const admin = await loginAs('admin@example.com', true);
        const target = await accounts.create({email: 'target@example.com', password: 'pw-strong-12'});
        const {captured} = await runAdmin({
            method: 'PATCH', path: `/api/admin/users/${target.id}`, cookie: admin.cookie,
            body: {}
        });
        expect(captured.status).toBe(400);
    });

    it('400 when password is too short', async () => {
        const admin = await loginAs('admin@example.com', true);
        const target = await accounts.create({email: 'target@example.com', password: 'pw-strong-12'});
        const {captured} = await runAdmin({
            method: 'PATCH', path: `/api/admin/users/${target.id}`, cookie: admin.cookie,
            body: {password: 'short'}
        });
        expect(captured.status).toBe(400);
    });
});

describe('method-not-allowed cases', () => {
    it('PUT /api/admin/users → 405', async () => {
        const admin = await loginAs('admin@example.com', true);
        const {captured} = await runAdmin({method: 'PUT', path: '/api/admin/users', cookie: admin.cookie});
        expect(captured.status).toBe(405);
    });

    it('DELETE /api/admin/users/:id → 405 (we do not destroy accounts)', async () => {
        const admin = await loginAs('admin@example.com', true);
        const target = await accounts.create({email: 'target@example.com', password: 'pw-strong-12'});
        const {captured} = await runAdmin({
            method: 'DELETE', path: `/api/admin/users/${target.id}`, cookie: admin.cookie
        });
        expect(captured.status).toBe(405);
    });
});