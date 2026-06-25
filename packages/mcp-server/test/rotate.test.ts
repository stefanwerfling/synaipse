import {describe, it, expect, vi} from 'vitest';
import {CachedUserStore} from '../src/CachedUserStore.js';
import {InMemoryUserStore} from './InMemoryUserStore.js';

describe('InMemoryUserStore.rotateByLabel', () => {
    it('returns null for an unknown label', async () => {
        const store = new InMemoryUserStore();
        const result = await store.rotateByLabel('nonexistent');
        expect(result).toBeNull();
    });

    it('rotates the bearer: old token dies, new token works, scope preserved', async () => {
        const store = new InMemoryUserStore();
        const {plainToken: oldToken, user: oldUser} = await store.createUser({
            label: 'rotate-me',
            read: true,
            write: true,
            pathPrefixes: ['Memory/'],
            tools: ['synaipse_search']
        });

        const rotated = await store.rotateByLabel('rotate-me');
        expect(rotated).not.toBeNull();
        expect(rotated?.plainToken).not.toBe(oldToken);

        // old token no longer authenticates
        expect(await store.findByToken(oldToken)).toBeNull();
        // new token does
        const fresh = await store.findByToken(rotated!.plainToken);
        expect(fresh).not.toBeNull();
        // id preserved (in-place update)
        expect(fresh?.id).toBe(oldUser.id);
        // scope preserved
        expect(fresh?.read).toBe(true);
        expect(fresh?.write).toBe(true);
        expect(fresh?.pathPrefixes).toEqual(['Memory/']);
        expect(fresh?.tools).toEqual(['synaipse_search']);
    });

    it('clears revoked_at — rotate on a revoked label restores it', async () => {
        const store = new InMemoryUserStore();
        const {plainToken: oldToken} = await store.createUser({label: 'r', read: true, write: false});

        await store.revokeByLabel('r');
        expect(await store.findByToken(oldToken)).toBeNull();

        const rotated = await store.rotateByLabel('r');
        expect(rotated).not.toBeNull();
        expect(rotated?.user.revokedAt).toBeNull();

        const fresh = await store.findByToken(rotated!.plainToken);
        expect(fresh).not.toBeNull();
    });

    it('applies the new expiresAt', async () => {
        const store = new InMemoryUserStore();
        await store.createUser({label: 'x', read: true, write: false});

        const futureExpiry = Date.now() + 30 * 86_400_000;
        const rotated = await store.rotateByLabel('x', futureExpiry);

        expect(rotated?.user.expiresAt).toBe(futureExpiry);
    });

    it('clears expiresAt when called without an argument', async () => {
        const store = new InMemoryUserStore();
        await store.createUser({label: 'x', read: true, write: false, expiresAt: Date.now() + 60_000});

        const rotated = await store.rotateByLabel('x');
        expect(rotated?.user.expiresAt).toBeNull();
    });

    it('clears last_used_at', async () => {
        const store = new InMemoryUserStore();
        const {user: created} = await store.createUser({label: 'x', read: true, write: false});

        await store.touchLastUsed(created.id);
        const list = await store.listUsers();
        expect(list.find((u) => u.id === created.id)?.lastUsedAt).not.toBeNull();

        const rotated = await store.rotateByLabel('x');
        expect(rotated?.user.lastUsedAt).toBeNull();
    });
});

describe('CachedUserStore.rotateByLabel', () => {
    it('flushes the cache after a successful rotate', async () => {
        const inner = new InMemoryUserStore();
        const cached = new CachedUserStore(inner, 60_000);
        const {plainToken: oldToken} = await cached.createUser({label: 'r', read: true, write: false});

        await cached.findByToken(oldToken);
        expect(cached.size()).toBe(1);

        const rotated = await cached.rotateByLabel('r');
        expect(rotated).not.toBeNull();
        expect(cached.size()).toBe(0);

        // verify the old cached entry is truly gone — re-querying old token returns null
        const spy = vi.spyOn(inner, 'findByToken');
        const stale = await cached.findByToken(oldToken);
        expect(stale).toBeNull();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does not flush when rotation reports no match', async () => {
        const inner = new InMemoryUserStore();
        const cached = new CachedUserStore(inner, 60_000);
        const {plainToken} = await cached.createUser({label: 'r', read: true, write: false});

        await cached.findByToken(plainToken);
        expect(cached.size()).toBe(1);

        const result = await cached.rotateByLabel('does-not-exist');
        expect(result).toBeNull();
        expect(cached.size()).toBe(1);
    });
});
