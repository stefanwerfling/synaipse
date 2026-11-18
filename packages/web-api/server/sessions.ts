import {randomBytes} from 'node:crypto';

/**
 * One server-side login session. SessionId is stored client-side in an
 * HttpOnly cookie; accountId points at the row in the `accounts` table.
 * createdAt + lastAccessedAt let us implement sliding TTL (refresh on
 * every authenticated request) without losing the original login time
 * for audit purposes.
 */
export interface Session {
    id: string;
    accountId: number;
    createdAt: number;
    lastAccessedAt: number;
    expiresAt: number;
}

export interface SessionStore {
    create(accountId: number): Session;
    get(id: string): Session | null;
    /** Refresh sliding TTL; returns the new expiresAt or null if id is unknown / expired. */
    touch(id: string): number | null;
    revoke(id: string): boolean;
    revokeAllForAccount(accountId: number): number;
    /** Drop expired entries. Returns the number purged. */
    sweep(): number;
}

export interface SessionStoreOptions {
    ttlMs?: number;
    nowSource?: () => number;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

/**
 * Process-local session store. Sessions die on restart — acceptable for
 * v1 because a forced re-login on deploy is a normal expectation; if it
 * becomes user-hostile we swap in a MariaDB-backed impl that fits the
 * same port. Lookups are O(1); the sweep helper covers the unbounded-
 * growth case under attack from random session-id probing (the get path
 * also lazily deletes expired entries).
 */
export class InMemorySessionStore implements SessionStore {
    private readonly sessions = new Map<string, Session>();
    private readonly ttlMs: number;
    private readonly now: () => number;

    public constructor(opts: SessionStoreOptions = {}) {
        this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
        this.now = opts.nowSource ?? Date.now;
    }

    public create(accountId: number): Session {
        const id = randomBytes(32).toString('base64url');
        const now = this.now();
        const session: Session = {
            id,
            accountId,
            createdAt: now,
            lastAccessedAt: now,
            expiresAt: now + this.ttlMs
        };
        this.sessions.set(id, session);
        return session;
    }

    public get(id: string): Session | null {
        const session = this.sessions.get(id);
        if (session === undefined) return null;

        if (session.expiresAt <= this.now()) {
            this.sessions.delete(id);
            return null;
        }

        return session;
    }

    public touch(id: string): number | null {
        const session = this.sessions.get(id);
        if (session === undefined) return null;

        const now = this.now();
        if (session.expiresAt <= now) {
            this.sessions.delete(id);
            return null;
        }

        session.lastAccessedAt = now;
        session.expiresAt = now + this.ttlMs;
        return session.expiresAt;
    }

    public revoke(id: string): boolean {
        return this.sessions.delete(id);
    }

    public revokeAllForAccount(accountId: number): number {
        let count = 0;
        for (const [id, s] of this.sessions) {
            if (s.accountId === accountId) {
                this.sessions.delete(id);
                count += 1;
            }
        }
        return count;
    }

    public sweep(): number {
        const now = this.now();
        let count = 0;
        for (const [id, s] of this.sessions) {
            if (s.expiresAt <= now) {
                this.sessions.delete(id);
                count += 1;
            }
        }
        return count;
    }
}

export const SESSION_COOKIE_NAME = 'synaipse_session';

export interface SerializedCookieOptions {
    /** Epoch ms; absent means session cookie (deleted on browser close). */
    expires?: number;
    /** Set Secure flag — only over HTTPS. Default false for localhost compatibility. */
    secure?: boolean;
    path?: string;
}

/**
 * Build a Set-Cookie header value for the session cookie. HttpOnly +
 * SameSite=Strict are non-negotiable: HttpOnly keeps JS out of the
 * cookie entirely (no XSS theft), SameSite=Strict is our CSRF defence
 * (no third-party origin can fire a cross-site POST with the cookie
 * attached). Secure is opt-in because dev runs over plain HTTP.
 */
export const serializeSessionCookie = (value: string, opts: SerializedCookieOptions = {}): string => {
    const parts = [`${SESSION_COOKIE_NAME}=${value}`];
    parts.push(`Path=${opts.path ?? '/'}`);
    parts.push('HttpOnly');
    parts.push('SameSite=Strict');
    if (opts.secure === true) parts.push('Secure');
    if (opts.expires !== undefined) parts.push(`Expires=${new Date(opts.expires).toUTCString()}`);
    return parts.join('; ');
};

/** Generate a clear-cookie value with an expired Expires date. */
export const clearSessionCookieHeader = (opts: {secure?: boolean; path?: string} = {}): string => {
    return serializeSessionCookie('', {
        ...opts,
        expires: 0
    });
};

/**
 * Parse a `Cookie` header value and return the session cookie value if
 * present. Tolerant of whitespace and unknown cookies. Returns null
 * when the header is absent, the cookie is missing, or the value is
 * empty (the cleared-cookie case).
 */
export const parseSessionCookie = (cookieHeader: string | undefined): string | null => {
    if (cookieHeader === undefined || cookieHeader.length === 0) return null;

    for (const raw of cookieHeader.split(';')) {
        const trimmed = raw.trim();
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const name = trimmed.slice(0, eq);
        if (name !== SESSION_COOKIE_NAME) continue;
        const value = trimmed.slice(eq + 1);
        return value.length === 0 ? null : value;
    }

    return null;
};