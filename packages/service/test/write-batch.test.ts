import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Chunk, NoteId, SearchHit} from '@synaipse/core';
import type {Embedder, VectorStore} from '@synaipse/vector';
import {SynaipseService} from '../src/Service.js';

/**
 * SynaipseService.batch (plan P1 / A1): writes inside a batch are
 * versioned as one commit and embedded in groups at the end; writes
 * outside the batch are unaffected.
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
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-batch-'));
    embedder = new FakeEmbedder();
    store = new MemoryStore();
    service = null;
});

afterEach(async () => {
    await service?.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('SynaipseService.batch', () => {
    it('commits all writes of a batch once and embeds them in one group', async () => {
        const svc = await boot();
        const callsBefore = embedder.calls;

        const ids = await svc.batch(async () => {
            const out: string[] = [];
            for (const n of ['a', 'b', 'c']) {
                out.push((await svc.writeNote({path: `${n}.md`, content: `note ${n}`})).id);
            }
            // visible immediately inside the batch, but not yet embedded
            expect(svc.tryReadNote(out[0]!)).toBeDefined();
            expect(store.noteIds().size).toBe(0);
            return out;
        }, {message: 'import: three notes'});

        expect(embedder.calls - callsBefore).toBe(1);
        expect(ids.every((id) => store.noteIds().has(id))).toBe(true);

        const shas = await Promise.all(ids.map(async (id) => (await svc.noteHistory(id)).map((h) => h.sha)));
        expect(shas.every((s) => s.length === 1)).toBe(true);
        expect(new Set(shas.map((s) => s[0])).size).toBe(1);
        expect((await svc.noteHistory(ids[0]!))[0]!.message).toBe('import: three notes');
    });

    it('does not swallow concurrent writes from outside the batch', async () => {
        const svc = await boot();
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });

        const running = svc.batch(async () => {
            await svc.writeNote({path: 'in.md', content: 'inside'});
            await gate;
        });
        const outside = await svc.writeNote({path: 'out.md', content: 'outside'});
        expect(store.noteIds().has(outside.id)).toBe(true); // embedded right away
        release();
        await running;

        const [outHist, inHist] = await Promise.all([svc.noteHistory(outside.id), svc.noteHistory('Memory/p/in.md')]);
        expect(outHist).toHaveLength(1);
        expect(inHist).toHaveLength(1);
        expect(outHist[0]!.sha).not.toBe(inHist[0]!.sha);
    });

    it('still versions and embeds what was written when the callback throws', async () => {
        const svc = await boot();
        await expect(svc.batch(async () => {
            await svc.writeNote({path: 'kept.md', content: 'kept'});
            throw new Error('crawler blew up');
        })).rejects.toThrow('crawler blew up');
        expect(store.noteIds().has('Memory/p/kept.md')).toBe(true);
        expect(await svc.noteHistory('Memory/p/kept.md')).toHaveLength(1);
    });

    it('skips notes deleted later in the batch and joins nested batches', async () => {
        const svc = await boot();
        await svc.batch(async () => {
            await svc.writeNote({path: 'gone.md', content: 'tmp'});
            await svc.batch(async () => {
                await svc.writeNote({path: 'nested.md', content: 'n'});
            });
            expect(store.noteIds().has('Memory/p/nested.md')).toBe(false); // joined, not flushed early
            await svc.deleteNote('Memory/p/gone.md');
        });
        expect(store.noteIds().has('Memory/p/gone.md')).toBe(false);
        expect(store.noteIds().has('Memory/p/nested.md')).toBe(true);
        // the create+delete of gone.md must not break the batch commit
        expect(await svc.noteHistory('Memory/p/nested.md')).toHaveLength(1);
        expect(await svc.noteHistory('Memory/p/gone.md')).toEqual([]);
    });

    it('deletes a note that existed before the batch in the batch commit', async () => {
        const svc = await boot();
        const {id} = await svc.writeNote({path: 'old.md', content: 'old'});
        await svc.batch(async () => {
            await svc.writeNote({path: 'new.md', content: 'new'});
            await svc.deleteNote(id);
        });
        const hist = await svc.noteHistory(id);
        expect(hist).toHaveLength(2);
        expect(hist[0]!.sha).toBe((await svc.noteHistory('Memory/p/new.md'))[0]!.sha);
    });

    it('marks the batch pending when the embedder is down', async () => {
        const svc = await boot();
        embedder.down = true;
        await svc.batch(async () => {
            await svc.writeNote({path: 'x.md', content: 'x'});
            await svc.writeNote({path: 'y.md', content: 'y'});
        });
        expect(svc.getLastIndexingStats().pending).toBe(2);
        expect(svc.tryReadNote('Memory/p/x.md')).toBeDefined();
    });
});
