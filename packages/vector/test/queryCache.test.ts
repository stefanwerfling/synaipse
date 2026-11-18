import {describe, expect, it} from 'vitest';
import {VectorIndex, queryCacheKey, type PersistentQueryCache} from '../src/Pipeline.js';
import type {Embedder} from '../src/Embeddings.js';
import type {VectorStore} from '../src/VectorStore.js';

const embedder = (): Embedder & {calls: string[]} => {
    const calls: string[] = [];
    return {
        dimension: 2,
        calls,
        embed: async (texts: string[]) => texts.map(() => [0.5, 0.25]),
        embedOne: async (text: string) => {
            calls.push(text);
            return [0.5, 0.25];
        }
    } as unknown as Embedder & {calls: string[]};
};

const store = {search: async () => []} as unknown as VectorStore;

const persistent = (): PersistentQueryCache & {data: Map<string, readonly number[]>} => {
    const data = new Map<string, readonly number[]>();
    return {
        data,
        get: (key) => (data.has(key) ? [...data.get(key)!] : undefined),
        set: (key, vector) => {
            data.set(key, vector);
        }
    };
};

describe('persistent query cache in the pipeline', () => {
    it('a fresh index (restart) reads the second level instead of embedding', async () => {
        const cache = persistent();
        const e1 = embedder();
        await new VectorIndex({embedder: e1, store, fingerprint: 'm1', persistentQueryCache: cache}).embedQuery('what is alpha');
        expect(e1.calls).toEqual(['what is alpha']);

        const e2 = embedder();
        const restarted = new VectorIndex({embedder: e2, store, fingerprint: 'm1', persistentQueryCache: cache});
        expect(await restarted.embedQuery('what is alpha')).toEqual([0.5, 0.25]);
        expect(e2.calls).toEqual([]);
    });

    it('keys are opaque and depend on the embedder fingerprint', async () => {
        const cache = persistent();
        await new VectorIndex({embedder: embedder(), store, fingerprint: 'm1', persistentQueryCache: cache}).embedQuery('secret query');
        const [key] = [...cache.data.keys()];

        expect(key).toMatch(/^[0-9a-f]{40}$/);
        expect(key).toBe(queryCacheKey('m1', 'secret query'));
        expect(queryCacheKey('m2', 'secret query')).not.toBe(key);

        const other = embedder();
        await new VectorIndex({embedder: other, store, fingerprint: 'm2', persistentQueryCache: cache}).embedQuery('secret query');
        expect(other.calls).toEqual(['secret query']);
    });
});
