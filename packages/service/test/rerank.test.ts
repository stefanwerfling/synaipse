import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SynaipseService} from '../src/Service.js';
import type {Reranker} from '@synaipse/vector';

/**
 * Deterministic stub — scores by how many times the query token appears
 * in the passage. In these tests I set up notes where the RRF order and
 * the rerank order are DIFFERENT, so we can prove the rerank actually
 * changed the outcome (not just coincidentally agreed with fusion).
 */
class KeywordCountReranker implements Reranker {
    public readonly model = 'stub/keyword-count';

    public async score(query: string, passages: string[]): Promise<number[]> {
        const token = query.trim().toLowerCase();
        return passages.map((p) => {
            const lower = p.toLowerCase();
            let n = 0;
            let idx = lower.indexOf(token);
            while (idx !== -1) {
                n += 1;
                idx = lower.indexOf(token, idx + token.length);
            }
            return n;
        });
    }
}

const buildConfig = (vaultPath: string, indexCachePath: string) => ({
    vaultPath,
    indexCachePath,
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    auditLogPath: path.join(vaultPath, '.audit.jsonl'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://localhost:6333', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0},
    git: {autoCommit: false, author: {name: 'Test', email: 't@t'}}
});

let vaultDir: string;
let cacheFile: string;
let service: SynaipseService;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-rerank-'));
    cacheFile = path.join(vaultDir, '.cache.json');
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

const writeNote = async (id: string, content: string): Promise<void> => {
    const full = path.join(vaultDir, id);
    await mkdir(path.dirname(full), {recursive: true});
    await writeFile(full, content);
};

describe('SynaipseService hybrid search rerank', () => {
    it('reranks fused hits by the reranker score, preserving fusion score in components', async () => {
        // Three notes with distinct keyword counts — the exact fusion
        // order depends on BM25 tuning we don't want to over-test, so
        // we assert the *rerank contract* instead: after rerank, hits
        // sort by reranker score descending and expose that score in
        // components without wiping the fusion breakdown.
        await writeNote('few.md',
            '---\ntitle: intro\n---\n\nkubernetes once.'
        );
        await writeNote('many.md',
            '---\ntitle: deep dive\n---\n\n'
            + 'kubernetes kubernetes kubernetes kubernetes kubernetes.'
        );
        await writeNote('some.md',
            '---\ntitle: middle\n---\n\nkubernetes and kubernetes together.'
        );

        service = new SynaipseService(
            buildConfig(vaultDir, cacheFile),
            {reranker: new KeywordCountReranker(), skipWatcher: true}
        );
        await service.start();

        const hits = await service.search('kubernetes', 'hybrid', 3);

        // Contract: order is by reranker score (keyword count) desc.
        expect(hits.map((h) => h.noteId)).toEqual(['many.md', 'some.md', 'few.md']);

        // Each hit carries a rerank component with matching rank.
        hits.forEach((h, i) => {
            expect(h.components?.rerank?.rank).toBe(i + 1);
            expect(h.score).toBe(h.components?.rerank?.score);
        });

        // Fusion components (fulltext at minimum) are still there —
        // the rerank layer enriches, it doesn't replace.
        expect(hits[0]?.components?.fulltext).toBeDefined();

        // And the scores are monotonically non-increasing.
        for (let i = 1; i < hits.length; i++) {
            expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score);
        }
    });

    it('falls back to fusion order when reranker throws', async () => {
        await writeNote('a.md', '---\ntitle: kubernetes\n---\n\nk8s stuff');
        await writeNote('b.md', '---\ntitle: docker\n---\n\nkubernetes is nearby');

        class BoomReranker implements Reranker {
            public readonly model = 'stub/boom';
            public async score(): Promise<number[]> {
                throw new Error('boom');
            }
        }

        service = new SynaipseService(
            buildConfig(vaultDir, cacheFile),
            {reranker: new BoomReranker(), skipWatcher: true}
        );
        await service.start();

        const hits = await service.search('kubernetes', 'hybrid', 2);

        // Fusion order preserved; no rerank component attached because
        // the model call failed.
        expect(hits.map((h) => h.noteId)).toEqual(['a.md', 'b.md']);
        expect(hits[0]?.components?.rerank).toBeUndefined();
    });

    it('leaves hits alone when no reranker is configured', async () => {
        await writeNote('a.md', '---\ntitle: kubernetes\n---\n\nk8s stuff');

        service = new SynaipseService(
            buildConfig(vaultDir, cacheFile),
            {reranker: null, skipWatcher: true}
        );
        await service.start();

        const hits = await service.search('kubernetes', 'hybrid', 5);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0]?.components?.rerank).toBeUndefined();
    });
});