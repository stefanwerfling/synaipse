import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SynaipseService} from '@synaipse/service';
import {buildTools, EMPTY_CTX, type ToolHandler} from '../src/Tools.js';

const buildConfig = (vaultPath: string, indexCachePath: string) => ({
    vaultPath,
    indexCachePath,
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    auditLogPath: path.join(vaultPath, '.audit.jsonl'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://localhost:6333', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0},
    project: {name: 'proj'}
});

let vaultDir: string;
let service: SynaipseService;
let tools: Map<string, ToolHandler>;

const parse = (outcome: {response: {content: Array<{text: string}>}}): any =>
    JSON.parse(outcome.response.content[0]!.text);

const call = (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`${name} not registered`);
    return tool.handle(args, EMPTY_CTX);
};

const addArgs = (over: Record<string, unknown> = {}) => ({
    dimensions: {machine: 'GB10', backend: 'vLLM'},
    metric: 'decode_tok_s',
    value: 75.1,
    unit: 'tok/s',
    higherIsBetter: true,
    ...over
});

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-bm-tool-'));
    service = new SynaipseService(buildConfig(vaultDir, path.join(vaultDir, '.cache.json')));
    await service.start();
    tools = new Map(buildTools(service).map((t) => [t.definition.name, t]));
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('benchmark tools registration + ACL', () => {
    it('registers all benchmark tools with correct modes', () => {
        expect(tools.get('synaipse_benchmark_add')?.mode).toBe('write');
        expect(tools.get('synaipse_benchmark_update')?.mode).toBe('write');
        expect(tools.get('synaipse_benchmark_list')?.mode).toBe('read');
    });
});

describe('synaipse_benchmark_add', () => {
    it('persists an entry and returns it with a generated id', async () => {
        const payload = parse(await call('synaipse_benchmark_add', addArgs()));
        expect(payload.entry.id).toMatch(/^b_[0-9a-f]{8}$/);
        expect(payload.entry.dimensions).toEqual({machine: 'GB10', backend: 'vLLM'});
        expect(payload.summary.totalEntries).toBe(1);

        const note = service.readNote('Memory/proj/_benchmarks.md');
        expect(note.frontmatter.benchmarks).toBeDefined();
    });

    it('accepts entries with a different project-specific dimension vocabulary', async () => {
        const payload = parse(await call('synaipse_benchmark_add', addArgs({
            dimensions: {language: 'Rust', algorithm: 'quicksort'},
            metric: 'sort_ms',
            unit: 'ms',
            higherIsBetter: false,
            value: 12
        })));
        expect(payload.entry.dimensions).toEqual({language: 'Rust', algorithm: 'quicksort'});
    });

    it('rejects an empty dimensions object', async () => {
        await expect(call('synaipse_benchmark_add', addArgs({dimensions: {}}))).rejects.toThrow(/dimensions/);
    });

    it('rejects missing required fields', async () => {
        const {higherIsBetter: _higherIsBetter, ...rest} = addArgs();
        await expect(call('synaipse_benchmark_add', rest)).rejects.toThrow(/higherIsBetter/);
    });

    it('throws with no active project', async () => {
        // buildConfig above configures a default project ('proj'); getProject()
        // falls back to it via `??`, so passing ctx.project:null doesn't clear
        // it — a genuinely project-less service is the only way to hit this path.
        const bareDir = await mkdtemp(path.join(tmpdir(), 'synaipse-bm-tool-bare-'));
        const bareService = new SynaipseService({...buildConfig(bareDir, path.join(bareDir, '.cache.json')), project: undefined});
        await bareService.start();
        const bareTools = new Map(buildTools(bareService).map((t) => [t.definition.name, t]));
        try {
            await expect(bareTools.get('synaipse_benchmark_add')!.handle(addArgs(), EMPTY_CTX))
                .rejects.toThrow(/No project context/);
        } finally {
            await bareService.stop();
            await rm(bareDir, {recursive: true, force: true});
        }
    });
});

describe('synaipse_benchmark_list', () => {
    it('filters by metric and dimensions, and returns winners + dimension keys', async () => {
        await call('synaipse_benchmark_add', addArgs({dimensions: {machine: 'GB10', backend: 'vLLM'}, value: 75.1}));
        await call('synaipse_benchmark_add', addArgs({dimensions: {machine: 'GB10', backend: 'mimirmind'}, value: 35.5}));
        await call('synaipse_benchmark_add', addArgs({dimensions: {machine: 'NUC'}, metric: 'prefill_ms', unit: 'ms', higherIsBetter: false, value: 100}));

        const all = parse(await call('synaipse_benchmark_list', {}));
        expect(all.entries).toHaveLength(3);
        expect(all.dimensionKeys).toEqual(['machine', 'backend']);

        const byMetric = parse(await call('synaipse_benchmark_list', {metric: 'decode_tok_s'}));
        expect(byMetric.entries).toHaveLength(2);

        const byDim = parse(await call('synaipse_benchmark_list', {dimensions: {backend: 'vLLM'}}));
        expect(byDim.entries).toHaveLength(1);
        expect(byDim.entries[0].dimensions.backend).toBe('vLLM');

        // default groupBy=['metric']: decode_tok_s group ranks vLLM above mimirmind
        const winners = parse(await call('synaipse_benchmark_list', {metric: 'decode_tok_s'})).winners;
        expect(winners).toHaveLength(1);
        expect(winners[0].entries[0].dimensions.backend).toBe('vLLM');
    });

    it('supports a scoped groupBy', async () => {
        await call('synaipse_benchmark_add', addArgs({dimensions: {machine: 'GB10'}, value: 10}));
        await call('synaipse_benchmark_add', addArgs({dimensions: {machine: 'GB10'}, value: 20}));
        await call('synaipse_benchmark_add', addArgs({dimensions: {machine: 'NUC'}, value: 5}));

        const payload = parse(await call('synaipse_benchmark_list', {groupBy: ['metric', 'machine']}));
        expect(payload.winners).toHaveLength(2);
        const gb10 = payload.winners.find((g: any) => g.groupBy.machine === 'GB10');
        expect(gb10.entries[0].value).toBe(20);
    });

    it('excludes soft-deleted entries by default, includes them with includeDeleted', async () => {
        const added = parse(await call('synaipse_benchmark_add', addArgs()));
        await call('synaipse_benchmark_update', {id: added.entry.id, deleted: true});

        expect(parse(await call('synaipse_benchmark_list', {})).entries).toHaveLength(0);
        expect(parse(await call('synaipse_benchmark_list', {includeDeleted: true})).entries).toHaveLength(1);
    });
});

describe('synaipse_benchmark_update', () => {
    it('patches only the passed fields', async () => {
        const added = parse(await call('synaipse_benchmark_add', addArgs()));
        const updated = parse(await call('synaipse_benchmark_update', {id: added.entry.id, value: 80, context: 'retest'}));
        expect(updated.entry.value).toBe(80);
        expect(updated.entry.context).toBe('retest');
        expect(updated.entry.metric).toBe('decode_tok_s'); // unchanged
    });

    it('soft-deletes and restores', async () => {
        const added = parse(await call('synaipse_benchmark_add', addArgs()));
        const deleted = parse(await call('synaipse_benchmark_update', {id: added.entry.id, deleted: true}));
        expect(deleted.entry.deleted).toBe(true);
        expect(parse(await call('synaipse_benchmark_list', {})).entries).toHaveLength(0);

        const restored = parse(await call('synaipse_benchmark_update', {id: added.entry.id, deleted: false}));
        expect(restored.entry.deleted).toBeUndefined();
        expect(parse(await call('synaipse_benchmark_list', {})).entries).toHaveLength(1);
    });

    it('throws for an unknown id', async () => {
        await expect(call('synaipse_benchmark_update', {id: 'nope', value: 1})).rejects.toThrow(/not found/);
    });
});
