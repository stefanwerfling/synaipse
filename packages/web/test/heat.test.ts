import {describe, it, expect} from 'vitest';
import {
    bumpedScore,
    currentHeatMap,
    decayFactor,
    HEAT_HALF_LIFE_MS,
    normalizeHeat
} from '../src/Heat.js';

describe('decayFactor', () => {
    it('returns 1 for zero elapsed time', () => {
        expect(decayFactor(0)).toBe(1);
    });

    it('halves over the half-life', () => {
        expect(decayFactor(HEAT_HALF_LIFE_MS)).toBeCloseTo(0.5);
    });

    it('quarters over two half-lives', () => {
        expect(decayFactor(2 * HEAT_HALF_LIFE_MS)).toBeCloseTo(0.25);
    });

    it('approaches zero for large elapsed times', () => {
        expect(decayFactor(20 * HEAT_HALF_LIFE_MS)).toBeLessThan(1e-5);
    });
});

describe('bumpedScore', () => {
    it('initializes from undefined', () => {
        expect(bumpedScore(undefined, 100, 1)).toEqual({score: 1, ts: 100});
    });

    it('adds amount on top of decayed previous score', () => {
        const entry = {score: 4, ts: 0};
        const next = bumpedScore(entry, HEAT_HALF_LIFE_MS, 1);

        expect(next.score).toBeCloseTo(3);
        expect(next.ts).toBe(HEAT_HALF_LIFE_MS);
    });
});

describe('currentHeatMap', () => {
    const state = {
        a: {score: 4, ts: 0},
        b: {score: 0.5, ts: 0},
        c: {score: 10, ts: HEAT_HALF_LIFE_MS}
    };

    it('returns decayed scores at the requested time', () => {
        const map = currentHeatMap(state, HEAT_HALF_LIFE_MS);
        expect(map.get('a')).toBeCloseTo(2);
        expect(map.get('c')).toBeCloseTo(10);
    });

    it('drops entries below the cleanup threshold', () => {
        const map = currentHeatMap(state, HEAT_HALF_LIFE_MS, HEAT_HALF_LIFE_MS, 1);
        expect(map.has('b')).toBe(false);
        expect(map.has('a')).toBe(true);
    });

    it('returns empty map for empty state', () => {
        expect(currentHeatMap({}, 0).size).toBe(0);
    });
});

describe('normalizeHeat', () => {
    it('returns 0 for non-positive scores', () => {
        expect(normalizeHeat(0)).toBe(0);
        expect(normalizeHeat(-1)).toBe(0);
    });

    it('clamps to 1 for very hot nodes', () => {
        expect(normalizeHeat(100)).toBe(1);
    });

    it('maps linearly up to the saturation point', () => {
        expect(normalizeHeat(2.5)).toBeCloseTo(0.5);
    });
});