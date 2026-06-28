import type {IncomingMessage, ServerResponse} from 'node:http';
import type {AccountRecord} from '@synaipse/core';
import type {AuthContext} from './auth-routes.js';
import {resolveCurrentAccount} from './auth-routes.js';

const MAX_EMAIL_LEN = 255;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 256;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(body));
};

const readJson = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.length === 0) throw new Error('empty body');
    return JSON.parse(raw);
};

const accountForWire = (a: AccountRecord): Record<string, unknown> => ({
    id: a.id,
    email: a.email,
    isAdmin: a.isAdmin,
    createdAt: a.createdAt,
    lastLoginAt: a.lastLoginAt,
    disabledAt: a.disabledAt
});

interface CreateBody {
    email?: unknown;
    password?: unknown;
    isAdmin?: unknown;
}

interface ParsedCreate {
    email: string;
    password: string;
    isAdmin: boolean;
}

const parseCreate = (raw: unknown): ParsedCreate | {error: string} => {
    if (typeof raw !== 'object' || raw === null) return {error: 'body must be an object'};
    const body = raw as CreateBody;

    if (typeof body.email !== 'string') return {error: "'email' is required (string)"};
    const email = body.email.trim().toLowerCase();
    if (email.length === 0) return {error: "'email' must not be empty"};
    if (email.length > MAX_EMAIL_LEN) return {error: `'email' too long (max ${MAX_EMAIL_LEN})`};
    if (!EMAIL_RE.test(email)) return {error: "'email' is not a valid address"};

    if (typeof body.password !== 'string') return {error: "'password' is required (string)"};
    if (body.password.length < MIN_PASSWORD_LEN) return {error: `'password' too short (min ${MIN_PASSWORD_LEN})`};
    if (body.password.length > MAX_PASSWORD_LEN) return {error: `'password' too long (max ${MAX_PASSWORD_LEN})`};

    const isAdmin = body.isAdmin === true;

    return {email, password: body.password, isAdmin};
};

interface PatchBody {
    disabled?: unknown;
    isAdmin?: unknown;
    password?: unknown;
}

interface ParsedPatch {
    disabled?: boolean;
    isAdmin?: boolean;
    password?: string;
}

const parsePatch = (raw: unknown): ParsedPatch | {error: string} => {
    if (typeof raw !== 'object' || raw === null) return {error: 'body must be an object'};
    const body = raw as PatchBody;
    const out: ParsedPatch = {};

    if (body.disabled !== undefined) {
        if (typeof body.disabled !== 'boolean') return {error: "'disabled' must be boolean"};
        out.disabled = body.disabled;
    }
    if (body.isAdmin !== undefined) {
        if (typeof body.isAdmin !== 'boolean') return {error: "'isAdmin' must be boolean"};
        out.isAdmin = body.isAdmin;
    }
    if (body.password !== undefined) {
        if (typeof body.password !== 'string') return {error: "'password' must be a string"};
        if (body.password.length < MIN_PASSWORD_LEN) return {error: `'password' too short (min ${MIN_PASSWORD_LEN})`};
        if (body.password.length > MAX_PASSWORD_LEN) return {error: `'password' too long (max ${MAX_PASSWORD_LEN})`};
        out.password = body.password;
    }

    if (out.disabled === undefined && out.isAdmin === undefined && out.password === undefined) {
        return {error: "patch body must set at least one of 'disabled', 'isAdmin', 'password'"};
    }

    return out;
};

export interface AdminRouteResult {
    handled: boolean;
}

/**
 * Admin user-management surface. Only `is_admin = true` accounts can hit
 * any of these — non-admins get 403 even though they hold a valid session.
 * Local-mode has no accounts table, so the whole tree 404s.
 *
 *   GET   /api/admin/users         — list every account in this vault
 *   POST  /api/admin/users         — create a new account
 *   PATCH /api/admin/users/:id     — set disabled / isAdmin / password
 *
 * Self-lockout guards: an admin cannot disable themselves and cannot
 * demote themselves out of admin (would brick the install if the only
 * admin did this by accident). Self password-change is allowed because
 * it's a normal operation. We do not expose DELETE — accounts get
 * disabled, never destroyed, so the audit trail stays intact.
 *
 * When disabling another user, every active session of that user is
 * revoked synchronously so the disable takes effect immediately rather
 * than waiting for cookie TTL.
 */
export const handleAdminRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    mode: 'local' | 'server',
    auth: AuthContext | null
): Promise<AdminRouteResult> => {
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (!path.startsWith('/api/admin/')) return {handled: false};

    if (mode === 'local' || auth === null) {
        json(res, 404, {error: 'admin api is server-mode only'});
        return {handled: true};
    }

    const current = await resolveCurrentAccount(req, auth);
    if (current === null) {
        json(res, 401, {error: 'authentication required'});
        return {handled: true};
    }

    if (!current.account.isAdmin) {
        json(res, 403, {error: 'admin only'});
        return {handled: true};
    }

    const accounts = auth.accounts;
    const me = current.account;

    if (path === '/api/admin/users') {
        if (method === 'GET') {
            const list = await accounts.listAccounts();
            json(res, 200, {accounts: list.map(accountForWire)});
            return {handled: true};
        }

        if (method === 'POST') {
            let body: unknown;
            try {
                body = await readJson(req);
            } catch {
                json(res, 400, {error: 'invalid JSON body'});
                return {handled: true};
            }

            const parsed = parseCreate(body);
            if ('error' in parsed) {
                json(res, 400, {error: parsed.error});
                return {handled: true};
            }

            let created: AccountRecord;
            try {
                created = await accounts.create({
                    email: parsed.email,
                    password: parsed.password,
                    isAdmin: parsed.isAdmin
                });
            } catch (cause) {
                const msg = cause instanceof Error ? cause.message : 'create failed';
                json(res, 409, {error: msg});
                return {handled: true};
            }
            json(res, 200, {account: accountForWire(created)});
            return {handled: true};
        }

        json(res, 405, {error: 'method not allowed'});
        return {handled: true};
    }

    const tail = path.slice('/api/admin/users/'.length);
    const idMatch = tail.match(/^(\d+)$/);
    if (idMatch === null) {
        json(res, 404, {error: 'not found'});
        return {handled: true};
    }

    const id = Number.parseInt(idMatch[1] as string, 10);

    if (method !== 'PATCH') {
        json(res, 405, {error: 'method not allowed'});
        return {handled: true};
    }

    let body: unknown;
    try {
        body = await readJson(req);
    } catch {
        json(res, 400, {error: 'invalid JSON body'});
        return {handled: true};
    }

    const parsed = parsePatch(body);
    if ('error' in parsed) {
        json(res, 400, {error: parsed.error});
        return {handled: true};
    }

    if (id === me.id) {
        if (parsed.disabled === true) {
            json(res, 400, {error: 'cannot disable your own account'});
            return {handled: true};
        }
        if (parsed.isAdmin === false) {
            json(res, 400, {error: 'cannot revoke your own admin'});
            return {handled: true};
        }
    }

    const target = await accounts.findById(id);
    if (target === null) {
        json(res, 404, {error: 'account not found'});
        return {handled: true};
    }

    if (parsed.password !== undefined) {
        await accounts.setPassword(id, parsed.password);
    }
    if (parsed.disabled !== undefined) {
        await accounts.setDisabled(id, parsed.disabled);
        if (parsed.disabled) {
            // Force-logout the user we just disabled so the cookie they
            // already hold stops working immediately. Required because
            // resolveCurrentAccount itself revokes sessions of disabled
            // accounts lazily — but we shouldn't wait for the user's next
            // request to clean it up.
            auth.sessions.revokeAllForAccount(id);
        }
    }
    if (parsed.isAdmin !== undefined) {
        await accounts.setAdmin(id, parsed.isAdmin);
    }

    const updated = await accounts.findById(id);
    if (updated === null) {
        json(res, 500, {error: 'account vanished during update'});
        return {handled: true};
    }
    json(res, 200, {account: accountForWire(updated)});
    return {handled: true};
};