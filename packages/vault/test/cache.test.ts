import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HashCache} from '../src/Cache.js';

let dir: string;
let file: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'synaipse-cache-'));
    file = path.join(dir, 'idx.json');
});

afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
});

describe('HashCache', () => {
    it('persists entries across reloads', async () => {
        const a = new HashCache(file, 0);
        a.set('n1.md', {hash: 'h1', mtime: 100});
        a.set('n2.md', {hash: 'h2', mtime: 200});
        await a.flush();

        const b = new HashCache(file, 0);
        await b.load();

        expect(b.get('n1.md')).toEqual({hash: 'h1', mtime: 100});
        expect(b.get('n2.md')).toEqual({hash: 'h2', mtime: 200});
        expect(b.size()).toBe(2);
    });

    it('ignores duplicate writes with identical hash + mtime', async () => {
        const cache = new HashCache(file, 0);
        cache.set('x.md', {hash: 'h', mtime: 1});
        await cache.flush();

        const before = await readFile(file, 'utf8');
        cache.set('x.md', {hash: 'h', mtime: 1});
        await cache.flush();
        const after = await readFile(file, 'utf8');

        expect(after).toBe(before);
    });

    it('drops deleted entries on flush', async () => {
        const cache = new HashCache(file, 0);
        cache.set('keep.md', {hash: 'k', mtime: 1});
        cache.set('drop.md', {hash: 'd', mtime: 2});
        await cache.flush();

        cache.delete('drop.md');
        await cache.flush();

        const fresh = new HashCache(file, 0);
        await fresh.load();
        expect(fresh.has('keep.md')).toBe(true);
        expect(fresh.has('drop.md')).toBe(false);
    });

    it('handles missing file as empty cache', async () => {
        const cache = new HashCache(path.join(dir, 'nope.json'), 0);
        await cache.load();
        expect(cache.size()).toBe(0);
    });

    it('handles corrupt file as empty cache', async () => {
        const {writeFile} = await import('node:fs/promises');
        await writeFile(file, '{not json');
        const cache = new HashCache(file, 0);
        await cache.load();
        expect(cache.size()).toBe(0);
    });

    it('touch increments accessCount and updates lastAccessed', async () => {
        const cache = new HashCache(file, 0);
        cache.set('n.md', {hash: 'h', mtime: 100});

        cache.touch('n.md', undefined, 1_000);
        cache.touch('n.md', undefined, 2_000);

        const entry = cache.get('n.md');
        expect(entry?.accessCount).toBe(2);
        expect(entry?.lastAccessed).toBe(2_000);
    });

    it('touch auto-inserts a minimal entry when none exists', async () => {
        const cache = new HashCache(file, 0);
        cache.touch('fresh.md', {hash: 'h', mtime: 50}, 9_999);

        const entry = cache.get('fresh.md');
        expect(entry?.hash).toBe('h');
        expect(entry?.mtime).toBe(50);
        expect(entry?.accessCount).toBe(1);
        expect(entry?.lastAccessed).toBe(9_999);
    });

    it('touch is a no-op when no seed and no existing entry', async () => {
        const cache = new HashCache(file, 0);
        cache.touch('missing.md');
        expect(cache.has('missing.md')).toBe(false);
    });

    it('set preserves existing access metadata when hash/mtime change', async () => {
        const cache = new HashCache(file, 0);
        cache.set('n.md', {hash: 'h1', mtime: 1});
        cache.touch('n.md', undefined, 5_000);
        cache.touch('n.md', undefined, 6_000);

        cache.set('n.md', {hash: 'h2', mtime: 2});

        const entry = cache.get('n.md');
        expect(entry?.hash).toBe('h2');
        expect(entry?.mtime).toBe(2);
        expect(entry?.accessCount).toBe(2);
        expect(entry?.lastAccessed).toBe(6_000);
    });

    it('persists access metadata across reloads', async () => {
        const a = new HashCache(file, 0);
        a.set('n.md', {hash: 'h', mtime: 1});
        a.touch('n.md', undefined, 1_234);
        await a.flush();

        const b = new HashCache(file, 0);
        await b.load();

        const entry = b.get('n.md');
        expect(entry?.accessCount).toBe(1);
        expect(entry?.lastAccessed).toBe(1_234);
    });

    it('loads legacy entries without access fields and treats counts as 0', async () => {
        const {writeFile} = await import('node:fs/promises');
        await writeFile(file, JSON.stringify({'old.md': {hash: 'h', mtime: 1}}), 'utf8');

        const cache = new HashCache(file, 0);
        await cache.load();

        const entry = cache.get('old.md');
        expect(entry?.accessCount).toBeUndefined();
        expect(entry?.lastAccessed).toBeUndefined();
    });
});