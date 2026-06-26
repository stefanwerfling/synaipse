import {describe, it, expect} from 'vitest';
import {
    InMemorySessionStore,
    SESSION_COOKIE_NAME,
    clearSessionCookieHeader,
    parseSessionCookie,
    serializeSessionCookie
} from '../server/sessions.js';

describe('InMemorySessionStore', () => {
    it('creates a session with a base64url-looking id', () => {
        const store = new InMemorySessionStore();
        const s = store.create(42);
        expect(s.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(s.accountId).toBe(42);
        expect(s.expiresAt).toBeGreaterThan(s.createdAt);
    });

    it('produces unique ids across creations', () => {
        const store = new InMemorySessionStore();
        const seen = new Set<string>();
        for (let i = 0; i < 16; i++) seen.add(store.create(1).id);
        expect(seen.size).toBe(16);
    });

    it('get returns the session while it is valid', () => {
        let now = 1000;
        const store = new InMemorySessionStore({ttlMs: 5000, nowSource: () => now});
        const s = store.create(7);
        expect(store.get(s.id)?.accountId).toBe(7);
        now = 4000;
        expect(store.get(s.id)).not.toBeNull();
    });

    it('get returns null and lazily deletes after expiry', () => {
        let now = 1000;
        const store = new InMemorySessionStore({ttlMs: 5000, nowSource: () => now});
        const s = store.create(7);
        now = 7000;
        expect(store.get(s.id)).toBeNull();
        now = 7001;
        // Second call should still return null but no longer hit the expired entry
        expect(store.get(s.id)).toBeNull();
    });

    it('get returns null for unknown ids', () => {
        const store = new InMemorySessionStore();
        expect(store.get('not-a-real-id')).toBeNull();
    });

    it('touch refreshes expiresAt and returns new value', () => {
        let now = 1000;
        const store = new InMemorySessionStore({ttlMs: 5000, nowSource: () => now});
        const s = store.create(1);
        const originalExpiry = s.expiresAt;
        now = 4000;
        const refreshed = store.touch(s.id);
        expect(refreshed).toBe(9000);
        expect(refreshed).toBeGreaterThan(originalExpiry);
    });

    it('touch returns null for expired sessions and removes them', () => {
        let now = 1000;
        const store = new InMemorySessionStore({ttlMs: 1000, nowSource: () => now});
        const s = store.create(1);
        now = 3000;
        expect(store.touch(s.id)).toBeNull();
        // Subsequent get should also fail (already removed)
        expect(store.get(s.id)).toBeNull();
    });

    it('touch returns null for unknown ids', () => {
        const store = new InMemorySessionStore();
        expect(store.touch('ghost')).toBeNull();
    });

    it('revoke removes the session and returns true', () => {
        const store = new InMemorySessionStore();
        const s = store.create(1);
        expect(store.revoke(s.id)).toBe(true);
        expect(store.get(s.id)).toBeNull();
        expect(store.revoke(s.id)).toBe(false);  // already gone
    });

    it('revokeAllForAccount drops every session for that account', () => {
        const store = new InMemorySessionStore();
        const s1 = store.create(1);
        const s2 = store.create(1);
        const s3 = store.create(2);
        expect(store.revokeAllForAccount(1)).toBe(2);
        expect(store.get(s1.id)).toBeNull();
        expect(store.get(s2.id)).toBeNull();
        expect(store.get(s3.id)?.accountId).toBe(2);
    });

    it('sweep purges expired entries and returns the count', () => {
        let now = 1000;
        const store = new InMemorySessionStore({ttlMs: 1000, nowSource: () => now});
        const s1 = store.create(1);
        store.create(2);
        now = 3000;
        // s1 + s2 both expired
        expect(store.sweep()).toBe(2);
        expect(store.get(s1.id)).toBeNull();
    });
});

describe('serializeSessionCookie', () => {
    it('always sets HttpOnly + SameSite=Strict + Path=/', () => {
        const header = serializeSessionCookie('abc');
        expect(header).toContain(`${SESSION_COOKIE_NAME}=abc`);
        expect(header).toContain('HttpOnly');
        expect(header).toContain('SameSite=Strict');
        expect(header).toContain('Path=/');
    });

    it('omits Secure by default (localhost compatibility)', () => {
        expect(serializeSessionCookie('abc')).not.toContain('Secure');
    });

    it('sets Secure when opted in', () => {
        expect(serializeSessionCookie('abc', {secure: true})).toContain('Secure');
    });

    it('includes an Expires date in UTC when given', () => {
        const t = Date.UTC(2030, 0, 1, 0, 0, 0);
        const header = serializeSessionCookie('abc', {expires: t});
        expect(header).toMatch(/Expires=.+GMT/);
    });
});

describe('clearSessionCookieHeader', () => {
    it('uses an expired Expires date and empty value', () => {
        const header = clearSessionCookieHeader();
        expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
        expect(header).toContain('Expires=');
        // Empty value comes right after the name=
        expect(header).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=(;| )`));
    });
});

describe('parseSessionCookie', () => {
    it('extracts the session value from a single-cookie header', () => {
        expect(parseSessionCookie('synaipse_session=abc')).toBe('abc');
    });

    it('returns null when the header is undefined or empty', () => {
        expect(parseSessionCookie(undefined)).toBeNull();
        expect(parseSessionCookie('')).toBeNull();
    });

    it('returns null when the cookie is absent', () => {
        expect(parseSessionCookie('other=1; another=2')).toBeNull();
    });

    it('returns null when the value is empty (cleared cookie)', () => {
        expect(parseSessionCookie('synaipse_session=')).toBeNull();
    });

    it('tolerates whitespace between cookies', () => {
        expect(parseSessionCookie('a=1;   synaipse_session=xyz   ; b=2')).toBe('xyz');
    });

    it('returns the right value even when other cookies share prefix substrings', () => {
        expect(parseSessionCookie('synaipse_session_other=wrong; synaipse_session=right'))
            .toBe('right');
    });
});