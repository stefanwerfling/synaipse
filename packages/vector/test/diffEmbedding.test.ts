import {describe, expect, it} from 'vitest';
import type {Chunk, Note, NoteId, SearchHit} from '@synaipse/core';
import type {Embedder} from '../src/Embedder.js';
import {QueryEmbeddingCache, VectorIndex} from '../src/Pipeline.js';
import type {VectorStore} from '../src/VectorStore.js';

/**
 * Plan P4 / A4: re-indexing embeds only chunks whose text changed, and
 * repeated queries hit the LRU instead of the embedder.
 */

const note = (id: string, paragraphs: string[]): Note => ({
    id,
    path: `${id}.md`,
    title: id,
    content: paragraphs.join('\n\n'),
    frontmatter: {},
    tags: [],
    wikilinks: [],
    backlinks: [],
    mtime: 0,
    hash: paragraphs.join('|')
});

/** Paragraphs long enough that each becomes its own chunk (target 1200). */
const para = (word: string): string => `${word} `.repeat(500).trim();

class CountingEmbedder implements Embedder {
    public readonly dimension = 2;
    public texts: string[] = [];
    public queries = 0;

    public async embed(texts: string[]): Promise<number[][]> {
        this.texts.push(...texts);
        return texts.map((t) => [t.length, t.charCodeAt(0)]);
    }

    public async embedOne(text: string): Promise<number[]> {
        this.queries++;
        return [text.length, 0];
    }
}

class HashStore implements VectorStore {
    public readonly points = new Map<string, {chunk: Chunk; vector: number[]}>();

    public async ensureCollection(): Promise<void> {}

    public async upsert(chunks: Chunk[], vectors: number[][]): Promise<void> {
        chunks.forEach((c, i) => this.points.set(c.id, {chunk: c, vector: vectors[i]!}));
    }

    public async deleteByNote(noteId: NoteId): Promise<void> {
        await this.deleteByNotes([noteId]);
    }

    public async deleteByNotes(noteIds: NoteId[]): Promise<void> {
        for (const [id, p] of this.points) if (noteIds.includes(p.chunk.noteId)) this.points.delete(id);
    }

    public async deleteStaleChunks(keep: ReadonlyMap<NoteId, number>): Promise<void> {
        for (const [id, p] of this.points) {
            const k = keep.get(p.chunk.noteId);
            if (k !== undefined && p.chunk.index >= k) this.points.delete(id);
        }
    }

    public async search(): Promise<SearchHit[]> {
        return [];
    }

    public async chunkHashes(noteIds: readonly NoteId[]): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        for (const p of this.points.values()) {
            if (noteIds.includes(p.chunk.noteId) && p.chunk.hash !== undefined) out.set(p.chunk.id, p.chunk.hash);
        }
        return out;
    }

    public async vectorsOf(chunkIds: readonly string[]): Promise<Map<string, number[]>> {
        return new Map(chunkIds.flatMap((id) => {
            const p = this.points.get(id);
            return p === undefined ? [] : [[id, p.vector] as [string, number[]]];
        }));
    }
}

describe('VectorIndex diff-embedding', () => {
    it('embeds only appended chunks of a growing note', async () => {
        const embedder = new CountingEmbedder();
        const store = new HashStore();
        const index = new VectorIndex({embedder, store, fingerprint: 'm1'});

        const first = await index.indexNotes([note('log', [para('a'), para('b')])]);
        expect(first).toMatchObject({chunks: 2, embedded: 2, reused: 0});

        embedder.texts = [];
        const second = await index.indexNotes([note('log', [para('a'), para('b'), para('c')])]);
        expect(second).toMatchObject({chunks: 3, embedded: 1, reused: 2});
        expect(embedder.texts).toHaveLength(1);
        expect(embedder.texts[0]!.endsWith(para('c'))).toBe(true);
        expect(store.points.size).toBe(3);
    });

    it('moves the stored vector when an unchanged chunk changes position', async () => {
        const embedder = new CountingEmbedder();
        const store = new HashStore();
        const index = new VectorIndex({embedder, store, fingerprint: 'm1'});

        await index.indexNotes([note('n', [para('a'), para('b')])]);
        const vectorOfB = store.points.get('n::1')!.vector;

        embedder.texts = [];
        // Chunks overlap by 150 chars, so prepending 'z' changes the chunk
        // of 'a' too; the chunk of 'b' (tail of 'a' + 'b') is unchanged
        // and moves from index 1 to 2.
        const result = await index.indexNotes([note('n', [para('z'), para('a'), para('b')])]);
        expect(result).toMatchObject({embedded: 2, reused: 1});
        expect(embedder.texts).toHaveLength(2);
        expect(embedder.texts[0]).toBe(para('z'));
        expect(store.points.get('n::2')!.vector).toEqual(vectorOfB);
    });

    it('re-embeds everything when the embedder fingerprint changes', async () => {
        const store = new HashStore();
        await new VectorIndex({embedder: new CountingEmbedder(), store, fingerprint: 'm1'})
            .indexNotes([note('n', [para('a'), para('b')])]);

        const embedder = new CountingEmbedder();
        const result = await new VectorIndex({embedder, store, fingerprint: 'm2'})
            .indexNotes([note('n', [para('a'), para('b')])]);
        expect(result).toMatchObject({embedded: 2, reused: 0});
    });

    it('caches query embeddings', async () => {
        const embedder = new CountingEmbedder();
        const index = new VectorIndex({embedder, store: new HashStore()});

        await index.semanticSearch('hello', 5);
        await index.semanticSearch('hello', 5);
        await index.semanticSearch('other', 5);
        expect(embedder.queries).toBe(2);
    });
});

describe('QueryEmbeddingCache', () => {
    it('evicts the least recently used entry', () => {
        const cache = new QueryEmbeddingCache(2);
        cache.set('a', [1]);
        cache.set('b', [2]);
        cache.get('a');
        cache.set('c', [3]);
        expect(cache.get('b')).toBeUndefined();
        expect(cache.get('a')).toEqual([1]);
        expect(cache.size).toBe(2);
    });
});
