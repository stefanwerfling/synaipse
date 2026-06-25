import {describe, it, expect, vi} from 'vitest';
import {CachedUserStore} from '../src/CachedUserStore.js';
import {InMemoryUserStore} from './InMemoryUserStore.js';

const buildStore = (ttlMs: number, nowSource?: () => number) => {
    const inner = new InMemoryUserStore();
    const cached = new CachedUserStore(inner, ttlMs, nowSource);
    return {inner, cached};
};

describe('CachedUserStore.findByToken', () => {
    it('caches a successful lookup so subsequent calls skip the inner store', async () => {
        const {inner, cached} = buildStore(60_000);
        const {plainToken} = await cached.createUser({label: 'a', read: true, write: false});

        const spy = vi.spyOn(inner, 'findByToken');

        const first = await cached.findByToken(plainToken);
        const second = await cached.findByToken(plainToken);
        const third = await cached.findByToken(plainToken);

        expect(first?.label).toBe('a');
        expect(second?.label).toBe('a');
        expect(third?.label).toBe('a');
        expect(spy).toHaveBeenCalledTimes(1);
        expect(cached.size()).toBe(1);
    });

    it('does not cache misses — every unknown token re-queries the inner store', async () => {
        const {inner, cached} = buildStore(60_000);
        const spy = vi.spyOn(inner, 'findByToken');

        const a = await cached.findByToken('never-issued-aaaaaaaa');
        const b = await cached.findByToken('never-issued-aaaaaaaa');

        expect(a).toBeNull();
        expect(b).toBeNull();
        expect(spy).toHaveBeenCalledTimes(2);
        expect(cached.size()).toBe(0);
    });

    it('respects the TTL — expired entries refetch from the inner store', async () => {
        let clock = 1_000_000;
        const {inner, cached} = buildStore(5_000, () => clock);
        const {plainToken} = await cached.createUser({label: 'a', read: true, write: false});

        const spy = vi.spyOn(inner, 'findByToken');

        await cached.findByToken(plainToken);                          // miss → fetches
        clock += 4_000;                                                // still inside TTL
        await cached.findByToken(plainToken);                          // hit → no fetch
        expect(spy).toHaveBeenCalledTimes(1);

        clock += 2_000;                                                // 6s elapsed > 5s TTL
        await cached.findByToken(plainToken);                          // miss → refetches
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('caches different tokens independently', async () => {
        const {inner, cached} = buildStore(60_000);
        const {plainToken: tokA} = await cached.createUser({label: 'a', read: true, write: false});
        const {plainToken: tokB} = await cached.createUser({label: 'b', read: true, write: true});

        const spy = vi.spyOn(inner, 'findByToken');

        const a1 = await cached.findByToken(tokA);
        const b1 = await cached.findByToken(tokB);
        const a2 = await cached.findByToken(tokA);
        const b2 = await cached.findByToken(tokB);

        expect(a1?.label).toBe('a');
        expect(b1?.label).toBe('b');
        expect(a2?.label).toBe('a');
        expect(b2?.label).toBe('b');
        expect(spy).toHaveBeenCalledTimes(2);
        expect(cached.size()).toBe(2);
    });
});

describe('CachedUserStore.revokeByLabel', () => {
    it('flushes the cache so a revoked token cannot re-authenticate from the cache', async () => {
        const {inner, cached} = buildStore(60_000);
        const {plainToken} = await cached.createUser({label: 'doomed', read: true, write: true});

        await cached.findByToken(plainToken);            // primes cache
        expect(cached.size()).toBe(1);

        const ok = await cached.revokeByLabel('doomed');
        expect(ok).toBe(true);
        expect(cached.size()).toBe(0);

        const spy = vi.spyOn(inner, 'findByToken');
        const after = await cached.findByToken(plainToken);
        expect(after).toBeNull();
        expect(spy).toHaveBeenCalledTimes(1);            // forced through to inner
    });

    it('does not flush when the inner revoke reports no match', async () => {
        const {cached} = buildStore(60_000);
        const {plainToken} = await cached.createUser({label: 'keep-me', read: true, write: false});

        await cached.findByToken(plainToken);
        expect(cached.size()).toBe(1);

        const ok = await cached.revokeByLabel('does-not-exist');
        expect(ok).toBe(false);
        expect(cached.size()).toBe(1);
    });
});

describe('CachedUserStore pass-through', () => {
    it('forwards createUser to the inner store and exposes the plain token', async () => {
        const {cached} = buildStore(60_000);
        const result = await cached.createUser({label: 'x', read: true, write: false});
        expect(result.plainToken.length).toBeGreaterThan(0);
        expect(result.user.label).toBe('x');
    });

    it('forwards listUsers without caching', async () => {
        const {inner, cached} = buildStore(60_000);
        await cached.createUser({label: 'a', read: true, write: false});
        const spy = vi.spyOn(inner, 'listUsers');
        await cached.listUsers();
        await cached.listUsers();
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('forwards touchLastUsed without invalidating the cache', async () => {
        const {inner, cached} = buildStore(60_000);
        const {plainToken, user} = await cached.createUser({label: 'a', read: true, write: false});

        await cached.findByToken(plainToken);
        expect(cached.size()).toBe(1);

        const spy = vi.spyOn(inner, 'touchLastUsed');
        await cached.touchLastUsed(user.id);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(cached.size()).toBe(1);
    });

    it('flush() clears the cache without touching the inner store', async () => {
        const {inner, cached} = buildStore(60_000);
        const {plainToken} = await cached.createUser({label: 'a', read: true, write: false});
        await cached.findByToken(plainToken);

        const spy = vi.spyOn(inner, 'findByToken');
        cached.flush();
        expect(cached.size()).toBe(0);

        await cached.findByToken(plainToken);
        expect(spy).toHaveBeenCalledTimes(1);
    });
});