import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, writeFile, mkdir, readdir} from 'node:fs/promises';
import {StateDb} from '@synaipse/vault';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Chunk, NoteId, SearchHit} from '@synaipse/core';
import type {Embedder, VectorStore} from '@synaipse/vector';
import {SynaipseService} from '../src/Service.js';

/**
 * Embedding lifecycle (plan P0 / B1, B4, B9): a note only counts as
 * embedded after the vector upsert succeeded; failures never lose the
 * write and are repaired later; a model switch triggers a re-embed.
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

    public async embed(texts: string[]): Promise<number[][]> {
        if (this.down) throw new Error('embedder down');
        this.embeddedTexts += texts.length;
        return texts.map(() => [1, 0, 0]);
    }

    public async embedOne(text: string): Promise<number[]> {
        return (await this.embed([text]))[0]!;
    }
}

class MemoryStore implements VectorStore {
    public readonly points = new Map<string, Chunk>();

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

    public async deleteStaleChunks(keep: ReadonlyMap<NoteId, number>): Promise<void> {
        for (const [id, c] of this.points) {
            const k = keep.get(c.noteId);
            if (k !== undefined && c.index >= k) this.points.delete(id);
        }
    }

    public async search(): Promise<SearchHit[]> {
        return [];
    }

    public noteIds(): Set<string> {
        return new Set([...this.points.values()].map((c) => c.noteId));
    }
}

const writeNote = async (root: string, relPath: string, body: string): Promise<void> => {
    const absolute = path.join(root, relPath);
    await mkdir(path.dirname(absolute), {recursive: true});
    await writeFile(absolute, body, 'utf8');
};

let vaultDir: string;
let service: SynaipseService | null;
let embedder: FakeEmbedder;
let store: MemoryStore;

const boot = async (model?: string): Promise<SynaipseService> => {
    service = new SynaipseService(buildConfig(vaultDir, model), {embedder, vectorStore: store, skipWatcher: true, reranker: null});
    await service.start();
    return service;
};

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-embed-'));
    embedder = new FakeEmbedder();
    store = new MemoryStore();
    service = null;
});

afterEach(async () => {
    await service?.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('embedding lifecycle', () => {
    it('embeds on first start and skips unchanged notes on the next start', async () => {
        await writeNote(vaultDir, 'a.md', '# A\n\nalpha');
        await writeNote(vaultDir, 'b.md', '# B\n\nbeta');

        const first = await boot();
        expect(first.getLastIndexingStats()).toMatchObject({reindexed: 2, unchanged: 0, pending: 0});
        await first.stop();

        const second = await boot();
        expect(second.getLastIndexingStats()).toMatchObject({reindexed: 0, unchanged: 2, pending: 0});
    });

    it('B1: a write whose embedding fails is saved, not marked embedded, and repaired on next start', async () => {
        const svc = await boot();
        embedder.down = true;

        const note = await svc.writeNote({path: 'x.md', content: '# X\n\nimportant'});
        expect(note.id).toBe('Memory/p/x.md');
        expect(store.noteIds().has(note.id)).toBe(false);
        expect(svc.getLastIndexingStats().pending).toBe(1);
        await svc.stop();

        embedder.down = false;
        const next = await boot();
        expect(next.getLastIndexingStats()).toMatchObject({reindexed: 1, pending: 0});
        expect(store.noteIds().has('Memory/p/x.md')).toBe(true);
    });

    it('B1: a failed embed is retried on the next write of the same note', async () => {
        const svc = await boot();
        embedder.down = true;
        const {id} = await svc.writeNote({path: 'n.md', content: 'v1'});
        embedder.down = false;
        await svc.writeNote({path: 'n.md', content: 'v2'});
        expect(store.noteIds().has(id)).toBe(true);
        expect(svc.getLastIndexingStats().pending).toBe(0);
    });

    it('B4: start-up keeps going in fulltext mode when the embedder is down and persists nothing as embedded', async () => {
        await writeNote(vaultDir, 'a.md', 'alpha');
        embedder.down = true;
        const svc = await boot();
        expect(svc.getLastIndexingStats()).toMatchObject({reindexed: 0, pending: 1});
        const hits = await svc.search('alpha', 'fulltext', 5);
        expect(hits.map((h) => h.noteId)).toEqual(['a.md']);
    });

    it('B5: switching the embedding model re-embeds every note', async () => {
        await writeNote(vaultDir, 'a.md', 'alpha');
        const first = await boot('model-one');
        expect(first.getLastIndexingStats().reindexed).toBe(1);
        await first.stop();

        const second = await boot('model-two');
        expect(second.getLastIndexingStats().reindexed).toBe(1);
    });

    it('migrates a pre-upgrade JSON cache (no fingerprint) into the state DB without re-embedding', async () => {
        await writeNote(vaultDir, 'a.md', 'alpha');
        const first = await boot();
        const note = first.readNote('a.md');
        await first.stop();

        // Simulate the pre-upgrade layout: no state DB, JSON sidecar with hash/mtime only.
        await rm(path.join(vaultDir, '.synaipse'), {recursive: true, force: true});
        const cacheFile = path.join(vaultDir, '.cache.json');
        await writeFile(cacheFile, JSON.stringify({'a.md': {hash: note.hash, mtime: note.mtime}}), 'utf8');

        const before = embedder.embeddedTexts;
        const second = await boot();
        expect(second.getLastIndexingStats()).toMatchObject({reindexed: 0, unchanged: 1});
        expect(embedder.embeddedTexts).toBe(before);
        await second.stop();

        const files = await readdir(vaultDir);
        expect(files).not.toContain('.cache.json');
        expect(files.some((f) => f.startsWith('.cache.json.migrated-'))).toBe(true);

        const state = new StateDb(path.join(vaultDir, '.synaipse', 'state.db'));
        const row = state.db.prepare('SELECT embed_model FROM entries WHERE id = ?').get('a.md') as {embed_model: string};
        state.close();
        expect(row.embed_model).toBe('voyage:voyage-test:3');
    });

    it('B9: a corrupt cache is kept as backup and triggers a (logged) full re-embed', async () => {
        await writeNote(vaultDir, 'a.md', 'alpha');
        await writeFile(path.join(vaultDir, '.cache.json'), '{"a.md": {"hash": ', 'utf8');

        const svc = await boot();
        expect(svc.getLastIndexingStats().reindexed).toBe(1);
        const files = await readdir(vaultDir);
        expect(files.some((f) => f.startsWith('.cache.json.corrupt-'))).toBe(true);
    });

    it('B4: shrinking a note trims its stale tail chunks', async () => {
        const para = (n: number) => Array.from({length: n}, (_, i) => `paragraph ${i} ` + 'word '.repeat(260)).join('\n\n');
        const svc = await boot();
        const {id} = await svc.writeNote({path: 'long.md', content: para(4)});
        const before = [...store.points.values()].filter((c) => c.noteId === id).length;
        expect(before).toBeGreaterThan(1);

        await svc.writeNote({path: 'long.md', content: 'short now'});
        const after = [...store.points.values()].filter((c) => c.noteId === id).length;
        expect(after).toBe(1);
    });
});
