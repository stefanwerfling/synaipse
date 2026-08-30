import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {BenchmarkEntry, BenchmarkSet} from '@synaipse/core';
import {SynaipseService} from '../src/Service.js';
import {benchmarkPathFor, projectFromBenchmarkPath} from '../src/Benchmark.js';

const buildConfig = (vaultPath: string, indexCachePath: string) => ({
    vaultPath,
    indexCachePath,
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    auditLogPath: path.join(vaultPath, '.audit.jsonl'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://localhost:6333', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0}
});

let vaultDir: string;
let cacheFile: string;
let service: SynaipseService;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-bm-'));
    cacheFile = path.join(vaultDir, '.cache.json');
    service = new SynaipseService(buildConfig(vaultDir, cacheFile));
    await service.start();
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

const entry = (id: string, over: Partial<BenchmarkEntry> = {}): BenchmarkEntry => ({
    id,
    dimensions: {machine: 'GB10', backend: 'vLLM'},
    metric: 'decode_tok_s',
    value: 75.1,
    unit: 'tok/s',
    higherIsBetter: true,
    ...over
});

const benchmarkSet = (entries: BenchmarkEntry[]): BenchmarkSet => ({
    project: 'demo',
    updatedAt: '',
    entries
});

describe('benchmarkPathFor / projectFromBenchmarkPath', () => {
    it('builds and reverses the note path', () => {
        expect(benchmarkPathFor('demo')).toBe('Memory/demo/_benchmarks.md');
        expect(projectFromBenchmarkPath('Memory/demo/_benchmarks.md')).toBe('demo');
        expect(projectFromBenchmarkPath('Memory/demo/other.md')).toBeNull();
    });

    it('rejects invalid project names', () => {
        expect(() => benchmarkPathFor('../etc')).toThrow();
    });
});

describe('SynaipseService benchmark round-trip', () => {
    it('returns an empty benchmark set before any write', () => {
        const set = service.readBenchmarks('demo');
        expect(set.entries).toEqual([]);
    });

    it('writes and reads back entries with arbitrary (project-specific) dimension keys', async () => {
        await service.writeBenchmarks(benchmarkSet([
            entry('1', {dimensions: {machine: 'GB10', backend: 'vLLM'}}),
            entry('2', {dimensions: {language: 'Rust', algorithm: 'quicksort'}, metric: 'sort_ms', unit: 'ms', higherIsBetter: false, value: 12})
        ]));

        const read = service.readBenchmarks('demo');
        expect(read.entries).toHaveLength(2);
        expect(read.entries[0]?.dimensions).toEqual({machine: 'GB10', backend: 'vLLM'});
        expect(read.entries[1]?.dimensions).toEqual({language: 'Rust', algorithm: 'quicksort'});
    });

    it('surfaces the benchmark set in the list view with a summary', async () => {
        await service.writeBenchmarks(benchmarkSet([entry('1')]));
        const list = service.listBenchmarks();
        const demo = list.find((s) => s.project === 'demo');
        expect(demo).toBeDefined();
        expect(demo?.totalEntries).toBe(1);
        expect(demo?.metrics).toEqual(['decode_tok_s']);
        expect(demo?.dimensionKeys).toEqual(['machine', 'backend']);
    });

    it('renders a human-readable body into the note, tagged benchmarks + project/<name>', async () => {
        await service.writeBenchmarks(benchmarkSet([entry('1')]));
        const note = service.readNote('Memory/demo/_benchmarks.md');
        expect(note.content).toContain('# Benchmarks: demo');
        expect(note.frontmatter.benchmarks).toBeDefined();
        expect(note.tags).toContain('benchmarks');
        expect(note.tags).toContain('project/demo');
    });

    it('keeps benchmark sets isolated per project', async () => {
        await service.writeBenchmarks({...benchmarkSet([entry('1')]), project: 'alpha'});
        await service.writeBenchmarks({...benchmarkSet([entry('2')]), project: 'beta'});

        expect(service.readBenchmarks('alpha').entries.map((e) => e.id)).toEqual(['1']);
        expect(service.readBenchmarks('beta').entries.map((e) => e.id)).toEqual(['2']);

        const projects = service.listBenchmarks().map((s) => s.project).sort();
        expect(projects).toEqual(['alpha', 'beta']);
    });
});
