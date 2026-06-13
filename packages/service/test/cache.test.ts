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
});