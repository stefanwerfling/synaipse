import type {IncomingMessage, ServerResponse} from 'node:http';
import type {AccountRecord, AccountStore} from '@synaipse/core';
import type {LoginRateLimit} from './login-rate-limit.js';
import {
    clearSessionCookieHeader,
    parseSessionCookie,
    serializeSessionCookie,
    type SessionStore
} from './sessions.js';

export interface AuthContext {
    sessions: SessionStore;
    accounts: AccountStore;
    rateLimit: LoginRateLimit;
    /** Set Secure flag on the session cookie. Recommended behind HTTPS, off for localhost. */
    secureCookie: boolean;
}

const json = (res: ServerResponse, status: number, body: unknown, setCookie?: string): void => {
    const headers: Record<string, string | string[]> = {'Content-Type': 'application/json'};
    if (setCookie !== undefined) headers['Set-Cookie'] = setCookie;
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
};

const accountForWire = (a: AccountRecord): Record<string, unknown> => ({
    id: a.id,
    email: a.email,
    isAdmin: a.isAdmin,
    createdAt: a.createdAt,
    lastLoginAt: a.lastLoginAt
});

const clientKey = (req: IncomingMessage): string => {
    // Prefer X-Forwarded-For when running behind a reverse proxy in
    // production. In dev there's no proxy and remoteAddress is the
    // direct client. We fall back to a constant string so a missing
    // socket address still buckets together rather than ending up un-
    // limited under a unique empty key per attempt.
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) {
        return (fwd.split(',')[0] ?? '').trim();
    }
    return req.socket?.remoteAddress ?? 'unknown';
};

const readJson = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.length === 0) throw new Error('empty body');
    return JSON.parse(raw);
};

export interface AuthRouteResult {
    /** True if the route fully handled the request. */
    handled: boolean;
}

/**
 * Resolve the current session into an AccountRecord, or null. Touches
 * the session (sliding TTL) when a valid record is found. Used by both
 * /api/auth/me and the requireAuth middleware so the policy stays in
 * one place.
 */
export const resolveCurrentAccount = async (
    req: IncomingMessage,
    auth: AuthContext
): Promise<{account: AccountRecord; sessionId: string} | null> => {
    const sessionId = parseSessionCookie(req.headers.cookie);
    if (sessionId === null) return null;

    const session = auth.sessions.get(sessionId);
    if (session === null) return null;

    const account = await auth.accounts.findById(session.accountId);
    if (account === null) {
        // Account row was deleted out from under the session — drop the
        // ghost session immediately so subsequent requests don't repeat
        // the lookup.
        auth.sessions.revoke(sessionId);
        return null;
    }

    if (account.disabledAt !== null) {
        // Account was disabled mid-session — revoke and refuse.
        auth.sessions.revoke(sessionId);
        return null;
    }

    auth.sessions.touch(sessionId);
    return {account, sessionId};
};

/**
 * Try to handle one of the auth endpoints. Returns {handled: false}
 * for any path the auth surface doesn't own so the caller can fall
 * through to its normal router. Endpoints:
 *
 *   GET  /api/auth/mode    — public; returns mode + auth status
 *   POST /api/auth/login   — body {email, password} → cookie + account
 *   POST /api/auth/logout  — clear cookie + revoke session
 *   GET  /api/auth/me      — return current account or 401
 */
export const handleAuthRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    mode: 'local' | 'server',
    auth: AuthContext | null
): Promise<AuthRouteResult> => {
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/api/auth/mode') {
        if (method !== 'GET') {
            json(res, 405, {error: 'method not allowed'});
            return {handled: true};
        }

        if (mode === 'local' || auth === null) {
            json(res, 200, {mode: 'local', authenticated: true});
            return {handled: true};
        }

        const current = await resolveCurrentAccount(req, auth);
        if (current === null) {
            json(res, 200, {mode: 'server', authenticated: false});
        } else {
            json(res, 200, {
                mode: 'server',
                authenticated: true,
                account: accountForWire(current.account)
            });
        }
        return {handled: true};
    }

    if (path === '/api/auth/login') {
        if (method !== 'POST') {
            json(res, 405, {error: 'method not allowed'});
            return {handled: true};
        }

        if (mode === 'local' || auth === null) {
            // Login is meaningless in local-mode — there is no account
            // table. Reply 404 instead of 200 so a misconfigured client
            // surfaces the mismatch immediately.
            json(res, 404, {error: 'login not available in local mode'});
            return {handled: true};
        }

        const key = clientKey(req);
        const remaining = auth.rateLimit.hit(key);
        if (remaining < 0) {
            json(res, 429, {error: 'too many login attempts, slow down'});
            return {handled: true};
        }

        let body: unknown;
        try {
            body = await readJson(req);
        } catch {
            json(res, 400, {error: 'invalid JSON body'});
            return {handled: true};
        }

        if (typeof body !== 'object' || body === null) {
            json(res, 400, {error: "body must be an object with 'email' and 'password'"});
            return {handled: true};
        }

        const obj = body as Record<string, unknown>;
        const email = typeof obj.email === 'string' ? obj.email.trim() : '';
        const password = typeof obj.password === 'string' ? obj.password : '';

        if (email.length === 0 || password.length === 0) {
            json(res, 400, {error: "'email' and 'password' are required"});
            return {handled: true};
        }

        const account = await auth.accounts.verifyLogin(email, password);
        if (account === null) {
            // Single failure path covers wrong email / wrong password /
            // disabled account — see AccountStore.verifyLogin doc for the
            // no-enumeration-oracle rationale.
            json(res, 401, {error: 'invalid email or password'});
            return {handled: true};
        }

        auth.rateLimit.reset(key);
        await auth.accounts.touchLastLogin(account.id);
        const session = auth.sessions.create(account.id);
        const cookie = serializeSessionCookie(session.id, {
            secure: auth.secureCookie,
            expires: session.expiresAt
        });
        json(res, 200, {account: accountForWire(account)}, cookie);
        return {handled: true};
    }

    if (path === '/api/auth/logout') {
        if (method !== 'POST') {
            json(res, 405, {error: 'method not allowed'});
            return {handled: true};
        }

        const cookie = clearSessionCookieHeader({secure: auth?.secureCookie ?? false});

        if (mode === 'local' || auth === null) {
            // Idempotent: even without a session, logout returns 200 so
            // the UI can call it unconditionally.
            json(res, 200, {ok: true}, cookie);
            return {handled: true};
        }

        const sessionId = parseSessionCookie(req.headers.cookie);
        if (sessionId !== null) auth.sessions.revoke(sessionId);
        json(res, 200, {ok: true}, cookie);
        return {handled: true};
    }

    if (path === '/api/auth/me') {
        if (method !== 'GET') {
            json(res, 405, {error: 'method not allowed'});
            return {handled: true};
        }

        if (mode === 'local' || auth === null) {
            // No account in local mode. Return 200 with a sentinel
            // rather than 401 so callers don't mistake this for an
            // expired session in server-mode.
            json(res, 200, {mode: 'local', account: null});
            return {handled: true};
        }

        const current = await resolveCurrentAccount(req, auth);
        if (current === null) {
            json(res, 401, {error: 'not authenticated'});
            return {handled: true};
        }

        json(res, 200, {mode: 'server', account: accountForWire(current.account)});
        return {handled: true};
    }

    return {handled: false};
};