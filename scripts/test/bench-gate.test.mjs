import {describe, expect, it} from 'vitest';
import {compare, METRICS} from '../bench-gate.mjs';
import {percentile} from '../bench-lib.mjs';

const run = (sizes) => ({sizes});

describe('bench gate (A7)', () => {
    it('flags a metric only over both the relative threshold and the absolute slack', () => {
        const baseline = run({10000: {coldStartMs: 3000, searchP95Ms: 4, writeP95Ms: 40, rssMiB: 600}});
        const current = run({10000: {coldStartMs: 3700, searchP95Ms: 6, writeP95Ms: 60, rssMiB: 640}});
        const rows = compare(current, baseline, 0.2);
        const byKey = Object.fromEntries(rows.map((r) => [r.key, r.regressed]));
        expect(byKey).toEqual({
            coldStartMs: true,   // +23 %, +700 ms > 400
            searchP95Ms: false,  // +50 % but only +2 ms
            writeP95Ms: true,    // +50 %, +20 ms > 15
            rssMiB: false        // +7 %
        });
    });

    it('improvements and missing baselines never fail', () => {
        const current = run({10000: {coldStartMs: 1000}, 50000: {coldStartMs: 9000}});
        const rows = compare(current, run({10000: {coldStartMs: 3000}}));
        expect(rows.every((r) => !r.regressed)).toBe(true);
        expect(rows.find((r) => r.size === 50000)?.was).toBeNull();
        expect(compare(current, null).every((r) => !r.regressed)).toBe(true);
    });

    it('every gated metric has a unit and a slack', () => {
        for (const spec of Object.values(METRICS)) {
            expect(spec.unit.length).toBeGreaterThan(0);
            expect(spec.slack).toBeGreaterThan(0);
        }
    });

    it('nearest-rank percentile', () => {
        const values = Array.from({length: 100}, (_, i) => i + 1);
        expect(percentile(values, 95)).toBe(95);
        expect(percentile([5], 95)).toBe(5);
        expect(percentile([3, 1, 2], 50)).toBe(2);
    });
});
