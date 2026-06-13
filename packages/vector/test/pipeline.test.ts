import {describe, it, expect, vi} from 'vitest';
import {VectorIndex, partitionChunks} from '../src/Pipeline.js';
import type {Chunk, Note} from '@synaipse/core';
import type {VoyageEmbedder, VoyageInputType} from '../src/Embeddings.js';
import type {QdrantStore} from '../src/Qdrant.js';

const para = (chars: number): string => 'word '.repeat(Math.ceil(chars / 5)).trim();

const note = (id: string, paras: number): Note => ({
    id,
    path: `/v/${id}`,
    title: id,
    content: Array.from({length: paras}, () => para(1100)).join('\n\n'),
    frontmatter: {},
    tags: [],
    wikilinks: [],
    backlinks: [],
    mtime: 0,
    hash: id
});

const fakeEmbedder = (): VoyageEmbedder & {calls: number[]} => {
    const calls: number[] = [];
    return {
        calls,
        embed: vi.fn(async (texts: string[], _t: VoyageInputType) => {
            calls.push(texts.length);
            return texts.map(() => [0, 0, 0]);
        }),
        embedOne: vi.fn()
    } as unknown as VoyageEmbedder & {calls: number[]};
};

const fakeStore = (): QdrantStore & {upserts: number[]; deletes: string[][]} => {
    const upserts: number[] = [];
    const deletes: string[][] = [];
    return {
        upserts,
        deletes,
        deleteByNote: vi.fn(),
        deleteByNotes: vi.fn(async (ids: string[]) => {
            deletes.push([...ids]);
        }),
        upsert: vi.fn(async (chunks: unknown[]) => {
            upserts.push(chunks.length);
        }),
        search: vi.fn(),
        ensureCollection: vi.fn()
    } as unknown as QdrantStore & {upserts: number[]; deletes: string[][]};
};

describe('VectorIndex.indexNotes', () => {
    it('batches chunks across notes, respecting batchSize', async () => {
        const embedder = fakeEmbedder();
        const store = fakeStore();
        const index = new VectorIndex({embedder, store, batchSize: 4});

        const notes = [note('a', 3), note('b', 3), note('c', 3)];
        const result = await index.indexNotes(notes);

        expect(result.notes).toBe(3);
        expect(result.chunks).toBe(9);
        expect(result.batches).toBe(3);

        expect(embedder.calls).toEqual([4, 4, 1]);
        expect(store.upserts).toEqual([4, 4, 1]);
    });

    it('deletes prior chunks for all notes in one filter call', async () => {
        const embedder = fakeEmbedder();
        const store = fakeStore();
        const index = new VectorIndex({embedder, store, batchSize: 64});

        await index.indexNotes([note('a', 1), note('b', 1)]);

        expect(store.deletes).toEqual([['a', 'b']]);
    });

    it('skips embedding when no chunks are produced', async () => {
        const embedder = fakeEmbedder();
        const store = fakeStore();
        const index = new VectorIndex({embedder, store});

        const empty: Note = {...note('empty', 0), content: ''};
        const result = await index.indexNotes([empty]);

        expect(result).toEqual({notes: 1, chunks: 0, batches: 0});
        expect(embedder.calls).toEqual([]);
    });

    it('reports progress via onBatch', async () => {
        const embedder = fakeEmbedder();
        const store = fakeStore();
        const events: Array<{batch: number; batches: number}> = [];
        const index = new VectorIndex({
            embedder,
            store,
            batchSize: 2,
            onBatch: ({batch, batches}) => events.push({batch, batches})
        });

        await index.indexNotes([note('a', 2), note('b', 3)]);

        expect(events).toEqual([
            {batch: 1, batches: 3},
            {batch: 2, batches: 3},
            {batch: 3, batches: 3}
        ]);
    });

    it('splits by char budget even when count limit is not reached', async () => {
        const embedder = fakeEmbedder();
        const store = fakeStore();
        const index = new VectorIndex({embedder, store, batchSize: 1000, maxBatchChars: 1500});

        const result = await index.indexNotes([note('big', 4)]);

        expect(result.chunks).toBe(4);
        expect(result.batches).toBeGreaterThan(1);
        expect(embedder.calls.reduce((a, b) => a + b, 0)).toBe(4);
    });

    it('warns on oversize chunk via onOversize', async () => {
        const embedder = fakeEmbedder();
        const store = fakeStore();
        const oversize: Chunk[] = [];
        const index = new VectorIndex({
            embedder,
            store,
            maxBatchChars: 50,
            onOversize: (c) => oversize.push(c)
        });

        await index.indexNotes([note('huge', 1)]);

        expect(oversize.length).toBeGreaterThan(0);
    });
});

describe('partitionChunks', () => {
    const ch = (id: string, len: number): Chunk => ({
        id, noteId: 'n', path: '/n', text: 'x'.repeat(len), index: 0
    });

    it('packs by count', () => {
        const p = partitionChunks([ch('a', 1), ch('b', 1), ch('c', 1)], 2, 10000);
        expect(p.map((x) => x.length)).toEqual([2, 1]);
    });

    it('packs by char budget', () => {
        const p = partitionChunks([ch('a', 40), ch('b', 40), ch('c', 40)], 999, 50);
        expect(p.map((x) => x.length)).toEqual([1, 1, 1]);
    });

    it('keeps an oversize chunk in its own partition', () => {
        const p = partitionChunks([ch('a', 5), ch('huge', 100), ch('b', 5)], 999, 50);
        expect(p.map((x) => x.map((c) => c.id))).toEqual([['a'], ['huge'], ['b']]);
    });

    it('returns empty for empty input', () => {
        expect(partitionChunks([], 10, 10)).toEqual([]);
    });
});