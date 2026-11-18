import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {existsSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import type {Chunk, NoteId, SearchHit} from '@synaipse/core';
import type {Embedder, VectorStore} from '@synaipse/vector';
import {computeLayout} from '../src/Layout.js';
import {LayoutComputer} from '../src/LayoutComputer.js';
import {SynaipseService} from '../src/Service.js';

/**
 * Plan P4 / A3: Atlas layout off the main thread, stale-while-revalidate.
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

const graph = {
    nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => ({id, title: id, tags: []})),
    edges: [
        {from: 'a', to: 'b', kind: 'wikilink' as const},
        {from: 'b', to: 'c', kind: 'wikilink' as const},
        {from: 'd', to: 'e', kind: 'wikilink' as const}
    ]
};

describe('LayoutComputer', () => {
    it('falls back to in-process when the worker entry is missing', async () => {
        const computer = new LayoutComputer(pathToFileURL('/nonexistent/LayoutWorkerEntry.js'));

        expect(computer.offThread).toBe(false);
        expect(await computer.compute(graph)).toEqual(computeLayout(graph));
        await computer.close();
    });

    const distEntry = path.resolve(__dirname, '../dist/LayoutWorkerEntry.js');

    it.skipIf(!existsSync(distEntry))('computes the same layout in a worker thread', async () => {
        const computer = new LayoutComputer(pathToFileURL(distEntry));

        expect(computer.offThread).toBe(true);
        const [first, second] = await Promise.all([computer.compute(graph), computer.compute({nodes: graph.nodes, edges: []})]);
        expect(first).toEqual(computeLayout(graph));
        expect(second.nodes).toHaveLength(5);
        await computer.close();
        await expect(computer.compute(graph)).rejects.toThrow(/closed/);
    });
});

let vaultDir: string;
let service: SynaipseService | null;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-layout-'));
    service = null;
});

afterEach(async () => {
    await service?.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('SynaipseService.graphLayout', () => {
    it('serves the old layout as stale after a write, then the fresh one', async () => {
        service = new SynaipseService(buildConfig(vaultDir), {embedder: new FakeEmbedder(), vectorStore: new MemoryStore(), skipWatcher: true, reranker: null});
        await service.start();
        await service.writeNote({path: 'a.md', content: 'links [[b]]'});
        await service.writeNote({path: 'b.md', content: 'b'});

        const first = await service.graphLayout();
        expect(first.stale).toBeUndefined();
        expect(first.nodes).toHaveLength(2);
        expect(await service.graphLayout()).toBe(first);

        await service.writeNote({path: 'c.md', content: 'links [[a]]'});
        const stale = await service.graphLayout();
        expect(stale.stale).toBe(true);
        expect(stale.hash).toBe(first.hash);

        await new Promise((resolve) => setTimeout(resolve, 1200));
        const fresh = await service.graphLayout();
        expect(fresh.stale).toBeUndefined();
        expect(fresh.nodes).toHaveLength(3);
        expect(fresh.hash).not.toBe(first.hash);
    });
});
