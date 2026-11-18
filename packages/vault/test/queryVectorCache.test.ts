import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {QueryVectorCache} from '../src/QueryVectorCache.js';

let dir: string;
let file: string;

beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'qvc-'));
    file = path.join(dir, 'state.db');
});

afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
});

describe('QueryVectorCache', () => {
    it('round-trips vectors bit-identically and survives reopening', () => {
        const vector = [0.1, -0.2 / 3, Math.PI, 1e-300, -0];
        const cache = new QueryVectorCache(file);
        cache.set('k1', vector);
        cache.close();

        const reopened = new QueryVectorCache(file);
        const back = reopened.get('k1');
        expect(back).toHaveLength(vector.length);
        back!.forEach((v, i) => expect(Object.is(v, vector[i])).toBe(true));
        expect(reopened.get('missing')).toBeUndefined();
        reopened.close();
    });

    it('evicts the least recently used entries beyond capacity', () => {
        const cache = new QueryVectorCache(file, {capacity: 3});
        let now = 1000;
        const realNow = Date.now;
        Date.now = () => now++;
        try {
            for (const k of ['a', 'b', 'c', 'd']) cache.set(k, [1]);
            cache.get('a');
            cache.prune();
        } finally {
            Date.now = realNow;
        }

        expect(cache.size()).toBe(3);
        expect(cache.get('b')).toBeUndefined();
        expect(cache.get('a')).toEqual([1]);
        cache.close();
    });

    it('never throws, also when closed', () => {
        const cache = new QueryVectorCache(file);
        cache.close();
        expect(cache.get('x')).toBeUndefined();
        expect(() => cache.set('x', [1])).not.toThrow();
    });
});
