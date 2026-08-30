import {describe, it, expect} from 'vitest';
import {
    type BenchmarkEntry,
    type BenchmarkSet,
    computeWinners,
    dimensionKeys,
    findEntry,
    generateEntryId,
    parseBenchmarkSet,
    renderBenchmarkMarkdown,
    serializeBenchmarkSet,
    setEntryDeleted,
    summarizeBenchmarks,
    upsertEntry,
    withoutDeletedEntries
} from '../src/Index.js';

const entry = (id: string, over: Partial<BenchmarkEntry> = {}): BenchmarkEntry => ({
    id,
    dimensions: {machine: 'GB10', backend: 'vLLM'},
    metric: 'decode_tok_s',
    value: 75.1,
    unit: 'tok/s',
    higherIsBetter: true,
    ...over
});

const set = (entries: BenchmarkEntry[], over: Partial<BenchmarkSet> = {}): BenchmarkSet => ({
    project: 'mimirmind',
    updatedAt: '2026-08-30T10:00:00.000Z',
    entries,
    ...over
});

describe('generateEntryId', () => {
    it('generates unique, prefixed ids', () => {
        const a = generateEntryId();
        const b = generateEntryId();
        expect(a).toMatch(/^b_[0-9a-f]{8}$/);
        expect(a).not.toBe(b);
    });
});

describe('findEntry', () => {
    it('finds by id or returns null', () => {
        const entries = [entry('1'), entry('2')];
        expect(findEntry(entries, '2')?.metric).toBe('decode_tok_s');
        expect(findEntry(entries, 'nope')).toBeNull();
    });
});

describe('upsertEntry', () => {
    it('appends a new id', () => {
        const next = upsertEntry([entry('1')], entry('2'));
        expect(next.map((e) => e.id)).toEqual(['1', '2']);
    });

    it('shallow-merges an existing id in place', () => {
        const next = upsertEntry([entry('1', {value: 10})], entry('1', {value: 20}));
        expect(next).toHaveLength(1);
        expect(next[0]?.value).toBe(20);
    });
});

describe('setEntryDeleted / withoutDeletedEntries', () => {
    it('flips the deleted flag without removing the entry', () => {
        const next = setEntryDeleted([entry('1'), entry('2')], '1', true);
        expect(next.find((e) => e.id === '1')?.deleted).toBe(true);
        expect(next.find((e) => e.id === '2')?.deleted).toBeUndefined();
        expect(next).toHaveLength(2);
    });

    it('restore clears the flag', () => {
        const deleted = setEntryDeleted([entry('1')], '1', true);
        const restored = setEntryDeleted(deleted, '1', false);
        expect(restored[0]?.deleted).toBeUndefined();
    });

    it('withoutDeletedEntries filters them out', () => {
        const entries = [entry('1'), entry('2', {deleted: true})];
        expect(withoutDeletedEntries(entries).map((e) => e.id)).toEqual(['1']);
    });

    it('a missing id is a no-op', () => {
        const entries = [entry('1')];
        expect(setEntryDeleted(entries, 'nope', true)).toEqual(entries);
    });
});

describe('dimensionKeys', () => {
    it('unions keys across entries in first-seen order, deduped', () => {
        const entries = [
            entry('1', {dimensions: {machine: 'GB10', backend: 'vLLM'}}),
            entry('2', {dimensions: {backend: 'HIP', technique: 'Q6_K'}})
        ];
        expect(dimensionKeys(entries)).toEqual(['machine', 'backend', 'technique']);
    });

    it('is empty for an empty entry list', () => {
        expect(dimensionKeys([])).toEqual([]);
    });
});

describe('computeWinners', () => {
    it('defaults to grouping by metric alone — always well-defined regardless of dimension vocabulary', () => {
        const entries = [
            entry('1', {dimensions: {language: 'Rust'}, metric: 'sort_ms', value: 12, higherIsBetter: false}),
            entry('2', {dimensions: {language: 'Python'}, metric: 'sort_ms', value: 40, higherIsBetter: false})
        ];
        const groups = computeWinners(entries);
        expect(groups).toHaveLength(1);
        expect(groups[0]?.entries.map((e) => e.id)).toEqual(['1', '2']); // lower is better, 12 wins
    });

    it('ranks higher-is-better metrics descending', () => {
        const entries = [entry('slow', {value: 35.5}), entry('fast', {value: 75.1})];
        const [group] = computeWinners(entries);
        expect(group?.entries.map((e) => e.id)).toEqual(['fast', 'slow']);
    });

    it('ranks lower-is-better metrics ascending', () => {
        const entries = [
            entry('slow', {metric: 'prefill_ms', value: 500, higherIsBetter: false}),
            entry('fast', {metric: 'prefill_ms', value: 100, higherIsBetter: false})
        ];
        const [group] = computeWinners(entries);
        expect(group?.entries.map((e) => e.id)).toEqual(['fast', 'slow']);
    });

    it('scopes rankings to an explicit groupBy dimension when the project has one', () => {
        const entries = [
            entry('a', {dimensions: {machine: 'GB10'}, value: 10}),
            entry('b', {dimensions: {machine: 'GB10'}, value: 20}),
            entry('c', {dimensions: {machine: 'NUC'}, value: 5})
        ];
        const groups = computeWinners(entries, ['metric', 'machine']);
        expect(groups).toHaveLength(2);
        const gb10 = groups.find((g) => g.groupBy.machine === 'GB10');
        expect(gb10?.entries.map((e) => e.id)).toEqual(['b', 'a']);
    });

    it('excludes entries missing a requested groupBy dimension rather than crashing', () => {
        const entries = [
            entry('has-machine', {dimensions: {machine: 'GB10'}}),
            entry('no-machine', {dimensions: {backend: 'vLLM'}})
        ];
        const groups = computeWinners(entries, ['metric', 'machine']);
        expect(groups).toHaveLength(1);
        expect(groups[0]?.entries.map((e) => e.id)).toEqual(['has-machine']);
    });

    it('returns no groups when the groupBy key exists on no entry at all', () => {
        const entries = [entry('1'), entry('2')];
        expect(computeWinners(entries, ['metric', 'nonexistent-key'])).toEqual([]);
    });

    it('handles a single-entry group', () => {
        const groups = computeWinners([entry('only')]);
        expect(groups[0]?.entries).toHaveLength(1);
    });

    it('excludes soft-deleted entries', () => {
        const entries = [entry('a', {value: 100, deleted: true}), entry('b', {value: 1})];
        const [group] = computeWinners(entries);
        expect(group?.entries.map((e) => e.id)).toEqual(['b']);
    });
});

describe('summarizeBenchmarks', () => {
    it('aggregates totals, dimension keys and metrics, excluding deleted entries', () => {
        const s = summarizeBenchmarks(set([
            entry('1', {dimensions: {machine: 'GB10'}, metric: 'decode_tok_s'}),
            entry('2', {dimensions: {backend: 'HIP'}, metric: 'prefill_ms'}),
            entry('3', {deleted: true})
        ]));
        expect(s.totalEntries).toBe(2);
        expect(s.dimensionKeys).toEqual(['machine', 'backend']);
        expect(s.metrics).toEqual(['decode_tok_s', 'prefill_ms']);
        expect(s.project).toBe('mimirmind');
    });
});

describe('parseBenchmarkSet / serializeBenchmarkSet', () => {
    it('round-trips through frontmatter', () => {
        const original = set([entry('1'), entry('2', {context: 'ctx', noteLinks: ['Some Note']})]);
        const frontmatter = {benchmarks: serializeBenchmarkSet(original), updated: original.updatedAt};
        const parsed = parseBenchmarkSet('mimirmind', frontmatter);
        expect(parsed?.entries).toHaveLength(2);
        expect(parsed?.entries[1]?.context).toBe('ctx');
        expect(parsed?.entries[1]?.noteLinks).toEqual(['Some Note']);
    });

    it('returns null when there is no benchmarks payload', () => {
        expect(parseBenchmarkSet('mimirmind', {})).toBeNull();
    });

    it('drops malformed entries silently', () => {
        const frontmatter = {
            benchmarks: {
                updatedAt: '2026-08-30T10:00:00.000Z',
                entries: [
                    {id: '1'}, // missing everything else
                    {id: '2', dimensions: {machine: 'GB10'}, metric: 'x', value: 1, unit: 'ms', higherIsBetter: true}
                ]
            }
        };
        const parsed = parseBenchmarkSet('mimirmind', frontmatter);
        expect(parsed?.entries.map((e) => e.id)).toEqual(['2']);
    });

    it('falls back to frontmatter.updated when benchmarks.updatedAt is absent', () => {
        const frontmatter = {benchmarks: {entries: []}, updated: '2026-08-01T00:00:00.000Z'};
        expect(parseBenchmarkSet('mimirmind', frontmatter)?.updatedAt).toBe('2026-08-01T00:00:00.000Z');
    });
});

describe('renderBenchmarkMarkdown', () => {
    it('renders dynamic dimension columns and a per-metric leaderboard with a winner marker', () => {
        const md = renderBenchmarkMarkdown(set([
            entry('slow', {dimensions: {machine: 'GB10', backend: 'mimirmind'}, value: 35.5}),
            entry('fast', {dimensions: {machine: 'GB10', backend: 'vLLM'}, value: 75.1})
        ]));
        expect(md).toContain('| machine | backend | Metrik | Wert | Kontext |');
        expect(md).toContain('### decode_tok_s');
        expect(md).toContain('🏆');
        expect(md.indexOf('vLLM')).toBeLessThan(md.indexOf('mimirmind', md.indexOf('Leaderboard')));
    });

    it('hides deleted entries but notes the count', () => {
        const md = renderBenchmarkMarkdown(set([entry('1'), entry('2', {deleted: true})]));
        expect(md).toContain('1 gelöscht (ausgeblendet)');
    });

    it('handles an empty set without crashing', () => {
        const md = renderBenchmarkMarkdown(set([]));
        expect(md).toContain('Noch keine Benchmark-Einträge');
    });
});
