import type {IncomingMessage, ServerResponse} from 'node:http';
import type {UserRecord} from '@synaipse/core';
import type {AuthContext} from './auth-routes.js';
import {resolveCurrentAccount} from './auth-routes.js';

const MAX_LABEL_LEN = 64;
const LABEL_RE = /^[a-zA-Z0-9_.\- ]+$/;
const MAX_EXPIRES_IN_DAYS = 365 * 5;  // 5 years; sanity cap, not a security boundary

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

/** Sanitized token DTO — same shape as UserRecord minus path/tool restrictions which are admin-only for v1. */
const tokenForWire = (u: UserRecord): Record<string, unknown> => ({
    id: u.id,
    label: u.label,
    read: u.read,
    write: u.write,
    tokenHint: u.tokenHint,
    createdAt: u.createdAt,
    lastUsedAt: u.lastUsedAt,
    revokedAt: u.revokedAt,
    expiresAt: u.expiresAt
});

interface CreateTokenBody {
    label?: unknown;
    read?: unknown;
    write?: unknown;
    expiresInDays?: unknown;
}

interface ParsedCreate {
    label: string;
    read: boolean;
    write: boolean;
    expiresAt: number | null;
}

const parseCreate = (raw: unknown): ParsedCreate | {error: string} => {
    if (typeof raw !== 'object' || raw === null) {
        return {error: "body must be an object"};
    }

    const body = raw as CreateTokenBody;

    if (typeof body.label !== 'string') {
        return {error: "'label' is required (string)"};
    }
    const label = body.label.trim();
    if (label.length === 0) return {error: "'label' must not be empty"};
    if (label.length > MAX_LABEL_LEN) return {error: `'label' too long (max ${MAX_LABEL_LEN})`};
    if (!LABEL_RE.test(label)) return {error: "'label' may only contain letters, digits, '_', '.', '-' and spaces"};

    const read = body.read === true;
    const write = body.write === true;
    if (!read && !write) return {error: "at least one of 'read' or 'write' must be true"};

    let expiresAt: number | null = null;
    if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
        if (typeof body.expiresInDays !== 'number' || !Number.isFinite(body.expiresInDays)) {
            return {error: "'expiresInDays' must be a positive number or null"};
        }
        if (body.expiresInDays <= 0) return {error: "'expiresInDays' must be > 0"};
        if (body.expiresInDays > MAX_EXPIRES_IN_DAYS) {
            return {error: `'expiresInDays' too large (max ${MAX_EXPIRES_IN_DAYS})`};
        }
        expiresAt = Date.now() + body.expiresInDays * 86_400_000;
    }

    return {label, read, write, expiresAt};
};

export interface TokenRouteResult {
    handled: boolean;
}

/**
 * Self-service token CRUD scoped to the current logged-in account.
 *
 *   GET    /api/tokens          — list MY tokens
 *   POST   /api/tokens          — create one for ME (returns plain bearer ONCE)
 *   DELETE /api/tokens/:id      — revoke MY token (404 if not mine)
 *   POST   /api/tokens/:id/rotate — rotate MY token (returns plain bearer ONCE)
 *
 * Mode=local has no account → 404 across the board.
 * All endpoints require a valid session in server-mode; routes.ts already
 * gates that ahead of this handler, but we re-resolve the account here to
 * pull the id we scope queries by.
 */
export const handleTokensRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    mode: 'local' | 'server',
    auth: AuthContext | null,
    userStoreGetter: () => Promise<{
        listByAccount: (accountId: number) => Promise<UserRecord[]>;
        createUser: (input: {label: string; read: boolean; write: boolean; expiresAt?: number | null; accountId?: number | null}) => Promise<{user: UserRecord; plainToken: string}>;
        revokeByIdForAccount: (id: number, accountId: number) => Promise<boolean>;
        rotateByIdForAccount: (id: number, accountId: number, expiresAt?: number | null) => Promise<{user: UserRecord; plainToken: string} | null>;
    }>
): Promise<TokenRouteResult> => {
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (!path.startsWith('/api/tokens')) return {handled: false};

    if (mode === 'local' || auth === null) {
        json(res, 404, {error: 'token self-service is server-mode only'});
        return {handled: true};
    }

    const current = await resolveCurrentAccount(req, auth);
    if (current === null) {
        json(res, 401, {error: 'authentication required'});
        return {handled: true};
    }

    const accountId = current.account.id;
    const userStore = await userStoreGetter();

    if (path === '/api/tokens') {
        if (method === 'GET') {
            const tokens = await userStore.listByAccount(accountId);
            json(res, 200, {tokens: tokens.map(tokenForWire)});
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

            const result = await userStore.createUser({
                label: parsed.label,
                read: parsed.read,
                write: parsed.write,
                expiresAt: parsed.expiresAt,
                accountId
            });

            json(res, 200, {
                token: tokenForWire(result.user),
                // Plain bearer is returned exactly once. Caller is expected
                // to display it to the user and then drop it — every
                // subsequent /api/tokens list will only ever surface the
                // hint, never the full bearer.
                plainToken: result.plainToken
            });
            return {handled: true};
        }

        json(res, 405, {error: 'method not allowed'});
        return {handled: true};
    }

    // Path-with-id branches: /api/tokens/123 (DELETE) + /api/tokens/123/rotate (POST)
    const tail = path.slice('/api/tokens/'.length);
    const rotateMatch = tail.match(/^(\d+)\/rotate$/);
    const idMatch = tail.match(/^(\d+)$/);

    if (rotateMatch !== null) {
        if (method !== 'POST') {
            json(res, 405, {error: 'method not allowed'});
            return {handled: true};
        }

        const id = Number.parseInt(rotateMatch[1] as string, 10);

        let body: unknown = {};
        if (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') {
            try {
                body = await readJson(req);
            } catch {
                // Rotate body is optional (expiresInDays only); empty/invalid → ignore
                body = {};
            }
        }

        let expiresAt: number | null = null;
        if (typeof body === 'object' && body !== null) {
            const d = (body as {expiresInDays?: unknown}).expiresInDays;
            if (typeof d === 'number' && Number.isFinite(d) && d > 0 && d <= MAX_EXPIRES_IN_DAYS) {
                expiresAt = Date.now() + d * 86_400_000;
            }
        }

        const result = await userStore.rotateByIdForAccount(id, accountId, expiresAt);
        if (result === null) {
            json(res, 404, {error: 'token not found'});
            return {handled: true};
        }

        json(res, 200, {
            token: tokenForWire(result.user),
            plainToken: result.plainToken
        });
        return {handled: true};
    }

    if (idMatch !== null) {
        if (method !== 'DELETE') {
            json(res, 405, {error: 'method not allowed'});
            return {handled: true};
        }

        const id = Number.parseInt(idMatch[1] as string, 10);
        const ok = await userStore.revokeByIdForAccount(id, accountId);
        if (!ok) {
            json(res, 404, {error: 'token not found or already revoked'});
            return {handled: true};
        }

        json(res, 200, {revoked: true});
        return {handled: true};
    }

    json(res, 404, {error: 'not found'});
    return {handled: true};
};