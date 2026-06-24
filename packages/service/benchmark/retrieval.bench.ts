import {describe, it, expect} from 'vitest';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import type {SearchMode} from '@synaipse/core';
import {SynaipseService} from '../src/Service.js';
import {NOTES, QUERIES, type BenchNote, type BenchQuery} from './fixtures.js';
import {recallAtK, precisionAtK, mrr, percentile} from './metrics.js';

interface RunMetrics {
    mode: SearchMode;
    queries: number;
    recallAt5: number;
    recallAt10: number;
    mrr: number;
    precisionAt5: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
}

const seedVault = async (root: string, notes: readonly BenchNote[]): Promise<void> => {
    for (const note of notes) {
        const abs = path.join(root, note.path);
        await mkdir(path.dirname(abs), {recursive: true});
        const fmTags = note.tags && note.tags.length > 0 ? `\ntags: [${note.tags.join(', ')}]` : '';
        const body = `---\ntitle: ${note.title}${fmTags}\n---\n${note.body}\n`;
        await writeFile(abs, body, 'utf8');
    }
};

const buildBenchConfig = (vaultDir: string, cacheFile: string) => ({
    vaultPath: vaultDir,
    indexCachePath: cacheFile,
    chatStoreDir: path.join(vaultDir, '..', 'chats'),
    auditLogPath: path.join(vaultDir, '.audit.jsonl'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://localhost:6333', collection: 'bench'},
    server: {name: 'synaipse-bench', version: '0.0.0'},
    web: {port: 0}
});

const evaluateMode = async (
    service: SynaipseService,
    queries: readonly BenchQuery[],
    mode: SearchMode
): Promise<RunMetrics> => {
    const latencies: number[] = [];
    let sumR5 = 0;
    let sumR10 = 0;
    let sumMrr = 0;
    let sumP5 = 0;

    for (const q of queries) {
        const start = performance.now();
        const hits = await service.search(q.query, mode, 10);
        latencies.push(performance.now() - start);

        const ids = hits.map((h) => h.noteId);
        const relevant = new Set(q.relevant);
        sumR5 += recallAtK(ids, relevant, 5);
        sumR10 += recallAtK(ids, relevant, 10);
        sumMrr += mrr(ids, relevant);
        sumP5 += precisionAtK(ids, relevant, 5);
    }

    latencies.sort((a, b) => a - b);
    const n = queries.length;
    return {
        mode,
        queries: n,
        recallAt5: sumR5 / n,
        recallAt10: sumR10 / n,
        mrr: sumMrr / n,
        precisionAt5: sumP5 / n,
        latencyP50Ms: percentile(latencies, 0.5),
        latencyP95Ms: percentile(latencies, 0.95)
    };
};

const formatTable = (results: readonly RunMetrics[]): string => {
    const fmt = (n: number, digits = 3) => n.toFixed(digits);
    const rows = results.map((r) =>
        `| ${r.mode.padEnd(8)} | ${String(r.queries).padStart(3)} | ${fmt(r.recallAt5)} | ${fmt(r.recallAt10)} | ${fmt(r.mrr)} | ${fmt(r.precisionAt5)} | ${fmt(r.latencyP50Ms, 1).padStart(6)} | ${fmt(r.latencyP95Ms, 1).padStart(6)} |`
    );
    return [
        '| Mode     |   N | R@5   | R@10  | MRR   | P@5   | p50 ms | p95 ms |',
        '|----------|----:|-------|-------|-------|-------|-------:|-------:|',
        ...rows
    ].join('\n');
};

describe('Synaipse retrieval benchmark', () => {
    it('measures recall, MRR, precision and latency per search mode', async () => {
        const vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-bench-'));
        const cacheFile = path.join(vaultDir, '.cache.json');

        try {
            await seedVault(vaultDir, NOTES);
            const service = new SynaipseService(buildBenchConfig(vaultDir, cacheFile));
            await service.start();

            try {
                // 'fulltext' and 'hybrid' run without external infra (embeddings=none).
                // Add 'semantic' to MODES when Qdrant + an embedding provider are up.
                const modes: SearchMode[] = ['fulltext', 'hybrid'];
                const results: RunMetrics[] = [];
                for (const mode of modes) {
                    results.push(await evaluateMode(service, QUERIES, mode));
                }

                const table = formatTable(results);
                console.log(`\nSynaipse retrieval benchmark — ${QUERIES.length} queries · ${NOTES.length} notes\n\n${table}\n`);

                const ts = new Date().toISOString().replace(/[:.]/g, '-');
                const outDir = path.resolve('packages/service/benchmark/results');
                await mkdir(outDir, {recursive: true});
                const out = path.join(outDir, `${ts}.json`);
                await writeFile(out, `${JSON.stringify({
                    timestamp: new Date().toISOString(),
                    noteCount: NOTES.length,
                    queryCount: QUERIES.length,
                    embeddingsProvider: 'none',
                    results
                }, null, 2)}\n`, 'utf8');
                console.log(`results → ${out}\n`);

                for (const r of results) {
                    expect(r.recallAt5).toBeGreaterThan(0);
                }
            } finally {
                await service.stop();
            }
        } finally {
            await rm(vaultDir, {recursive: true, force: true});
        }
    }, 60_000);
});