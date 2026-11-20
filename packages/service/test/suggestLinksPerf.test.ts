import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Chunk, NoteId, SearchHit, SearchScope} from '@synaipse/core';
import type {Embedder, VectorStore} from '@synaipse/vector';
import {SynaipseService} from '../src/Service.js';

/**
 * Plan P4 / A3: suggestLinks answers semantic neighbours from stored
 * vectors (no embedding per note) and caches its result per vault
 * generation, serving the previous result while recomputing.
 */

const buildConfig = (vaultPath: string, model = 'voyage-test') => ({
    vaultPath,
    indexCachePath: path.join(vaultPath, '.cache.json'),
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    auditLogPath: path.join(vaultPath, '.audit.jsonl'),
    embeddings: {provider: 'voyage' as const},
    voyage: {apiKey: 'test', model},
    qdrant: {url: 'http://localhost:6333', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0},
    project: {name: 'p'}
});

class FakeEmbedder implements Embedder {
    public readonly dimension = 3;
    public down = false;
    public embeddedTexts = 0;
    public calls = 0;

    public async embed(texts: string[]): Promise<number[][]> {
        if (this.down) throw new Error('embedder down');
        this.calls++;
        this.embeddedTexts += texts.length;
        return texts.map(() => [1, 0, 0]);
    }

    public async embedOne(text: string): Promise<number[]> {
        return (await this.embed([text]))[0]!;
    }
}

const isX = (id: string): boolean => path.basename(id).startsWith('x-');

/** Every chunk of note "x-*" is close to every other "x-*" note. */
class SimilarStore implements VectorStore {
    public readonly points = new Map<string, Chunk>();
    public similarCalls = 0;
    public lastScope: SearchScope | undefined;

    public async ensureCollection(): Promise<void> {}

    public async upsert(chunks: Chunk[]): Promise<void> {
        for (const c of chunks) this.points.set(c.id, c);
    }

    public async deleteByNote(noteId: NoteId): Promise<void> {
        await this.deleteByNotes([noteId]);
    }

    public async deleteByNotes(noteIds: NoteId[]): Promise<void> {
        for (const [id, c] of this.points) if (noteIds.includes(c.noteId)) this.points.delete(id);
    }

    public async deleteStaleChunks(): Promise<void> {}

    public async search(): Promise<SearchHit[]> {
        return [];
    }

    public async similarToChunks(chunkIds: readonly string[], limit: number, scope?: SearchScope): Promise<Map<string, SearchHit[]>> {
        this.similarCalls++;
        this.lastScope = scope;
        const out = new Map<string, SearchHit[]>();
        for (const chunkId of chunkIds) {
            const own = this.points.get(chunkId);
            if (own === undefined) continue;
            const hits = [...this.points.values()]
                .filter((c) => c.index === 0 && c.noteId !== own.noteId && isX(c.noteId) && isX(own.noteId))
                .map((c) => ({noteId: c.noteId, path: c.path, title: c.noteId, score: 0.9, snippet: '', chunkId: c.id}));
            out.set(chunkId, hits.slice(0, limit));
        }
        return out;
    }
}

let vaultDir: string;
let service: SynaipseService | null;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-suggest-'));
    service = null;
});

afterEach(async () => {
    await service?.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

const boot = async (embedder: FakeEmbedder, store: SimilarStore): Promise<SynaipseService> => {
    service = new SynaipseService(buildConfig(vaultDir), {embedder, vectorStore: store, skipWatcher: true, reranker: null});
    await service.start();
    return service;
};

const pairs = (list: Array<{a: string; b: string}>): string[] => list.map((s) => [path.basename(s.a), path.basename(s.b)].sort().join('|')).sort();

describe('suggestLinks performance path', () => {
    it('uses stored vectors instead of embedding every note', async () => {
        const embedder = new FakeEmbedder();
        const store = new SimilarStore();
        const svc = await boot(embedder, store);
        for (const n of ['x-a', 'x-b', 'x-c']) await svc.writeNote({path: `${n}.md`, content: `note ${n}`});

        const callsBefore = embedder.calls;
        const result = await svc.suggestLinks();

        expect(pairs(result.filter((s) => s.reasons.includes('semantic')))).toEqual(['x-a.md|x-b.md', 'x-a.md|x-c.md', 'x-b.md|x-c.md']);
        expect(embedder.calls).toBe(callsBefore);
        expect(store.similarCalls).toBe(1);
    });

    it('serves the cached result, drops newly linked pairs, then refreshes', async () => {
        const embedder = new FakeEmbedder();
        const store = new SimilarStore();
        const svc = await boot(embedder, store);
        for (const n of ['x-a', 'x-b', 'x-c']) await svc.writeNote({path: `${n}.md`, content: `note ${n}`});

        await svc.suggestLinks();
        await svc.suggestLinks();
        expect(store.similarCalls).toBe(1);

        await svc.writeNote({path: 'x-a.md', content: 'note x-a links [[x-b]]'});
        const stale = await svc.suggestLinks();
        expect(pairs(stale)).not.toContain('x-a.md|x-b.md');
        expect(pairs(stale)).toContain('x-a.md|x-c.md');

        // the background recompute has been started by the stale call
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(store.similarCalls).toBe(2);
        const fresh = await svc.suggestLinks();
        expect(store.similarCalls).toBe(2);
        expect(pairs(fresh)).not.toContain('x-a.md|x-b.md');
    });

    it('asks the store for neighbours inside pathPrefix (P4 A4)', async () => {
        const store = new SimilarStore();
        const svc = await boot(new FakeEmbedder(), store);
        for (const n of ['x-a', 'x-b']) await svc.writeNote({path: `in/${n}.md`, content: `note ${n}`});
        await svc.writeNote({path: 'out/x-c.md', content: 'note x-c'});

        const result = await svc.suggestLinks({pathPrefix: 'Memory/p/in/'});
        expect(store.lastScope).toEqual({include: ['Memory/p/in/']});
        expect(pairs(result.filter((s) => s.reasons.includes('semantic')))).toEqual(['x-a.md|x-b.md']);

        await svc.suggestLinks({pathPrefix: ''});
        expect(store.lastScope).toBeUndefined();
    });
});
