import {describe, it, expect, vi, afterEach} from 'vitest';
import {CachedUserStore} from '../src/CachedUserStore.js';
import {InMemoryUserStore} from './InMemoryUserStore.js';

afterEach(() => {
    vi.useRealTimers();
});

describe('InMemoryUserStore expiry', () => {
    it('returns the record while expiresAt is in the future', async () => {
        const store = new InMemoryUserStore();
        const {plainToken, user} = await store.createUser({
            label: 'short-lived',
            read: true,
            write: false,
            expiresAt: Date.now() + 60_000
        });

        expect(user.expiresAt).not.toBeNull();
        const record = await store.findByToken(plainToken);
        expect(record).not.toBeNull();
        expect(record?.label).toBe('short-lived');
    });

    it('returns null once expiresAt has passed', async () => {
        const store = new InMemoryUserStore();
        const {plainToken} = await store.createUser({
            label: 'expired',
            read: true,
            write: false,
            expiresAt: Date.now() - 1_000
        });

        const record = await store.findByToken(plainToken);
        expect(record).toBeNull();
    });

    it('treats null expiresAt as never-expires', async () => {
        const store = new InMemoryUserStore();
        const {plainToken} = await store.createUser({
            label: 'forever',
            read: true,
            write: false
        });

        const record = await store.findByToken(plainToken);
        expect(record?.expiresAt).toBeNull();
    });

    it('listUsers includes both active and expired entries', async () => {
        const store = new InMemoryUserStore();
        await store.createUser({label: 'active', read: true, write: false, expiresAt: Date.now() + 60_000});
        await store.createUser({label: 'expired', read: true, write: false, expiresAt: Date.now() - 1_000});

        const users = await store.listUsers();
        expect(users.map((u) => u.label).sort()).toEqual(['active', 'expired']);
    });
});

describe('CachedUserStore caps cache TTL by user.expiresAt', () => {
    it('caches only up to user expiry when expiry is sooner than TTL', async () => {
        let clock = 1_000_000;
        const inner = new InMemoryUserStore();
        const cached = new CachedUserStore(inner, 60_000, () => clock);

        // Use real-time createUser (epoch), then advance the cached clock
        // independently so cache TTL math is deterministic.
        const userExpiry = clock + 5_000;
        // InMemoryUserStore.findByToken filters by Date.now(); freeze it so
        // the fresh lookup observes the same "now" as the cache.
        vi.useFakeTimers();
        vi.setSystemTime(clock);

        const {plainToken} = await cached.createUser({
            label: 'short',
            read: true,
            write: false,
            expiresAt: userExpiry
        });

        const spy = vi.spyOn(inner, 'findByToken');

        await cached.findByToken(plainToken);            // miss → fetches + caches with min(now+60s, expiry=5s after now) = 5s
        clock += 4_000;
        vi.setSystemTime(clock);
        await cached.findByToken(plainToken);            // hit (within 5s)
        expect(spy).toHaveBeenCalledTimes(1);

        clock += 2_000;                                  // 6s total — past user expiry
        vi.setSystemTime(clock);
        await cached.findByToken(plainToken);            // cache entry expired → refetch, inner returns null
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('uses full TTL when no user expiry is set', async () => {
        let clock = 1_000_000;
        const inner = new InMemoryUserStore();
        const cached = new CachedUserStore(inner, 60_000, () => clock);

        const {plainToken} = await cached.createUser({
            label: 'forever',
            read: true,
            write: false
        });

        const spy = vi.spyOn(inner, 'findByToken');

        await cached.findByToken(plainToken);
        clock += 30_000;                                 // half the TTL
        await cached.findByToken(plainToken);
        expect(spy).toHaveBeenCalledTimes(1);

        clock += 31_000;                                 // 61s — past TTL
        await cached.findByToken(plainToken);
        expect(spy).toHaveBeenCalledTimes(2);
    });
});