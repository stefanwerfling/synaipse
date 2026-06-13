import {describe, it, expect} from 'vitest';
import {bezierControl, easeOutCubic, trailOpacity, trailSvgPath} from '../src/Trail.js';

describe('bezierControl', () => {
    it('returns midpoint when both endpoints are identical', () => {
        const p = bezierControl({x: 10, y: 10}, {x: 10, y: 10}, 50);
        expect(p).toEqual({x: 10, y: 10});
    });

    it('produces a perpendicular offset from the midpoint', () => {
        const a = {x: 0, y: 0};
        const b = {x: 100, y: 0};
        const c = bezierControl(a, b, 40);

        expect(c.x).toBeCloseTo(50);
        expect(c.y).toBeCloseTo(40);
    });

    it('flips the offset when the curveStrength is negative', () => {
        const c = bezierControl({x: 0, y: 0}, {x: 100, y: 0}, -30);
        expect(c.y).toBeCloseTo(-30);
    });
});

describe('trailSvgPath', () => {
    it('formats a quadratic bezier path with 1-decimal precision', () => {
        const p = trailSvgPath({x: 1.234, y: 2.567}, {x: 9.876, y: 8.111}, {x: 5.5, y: 5.5});
        expect(p).toBe('M 1.2 2.6 Q 5.5 5.5 9.9 8.1');
    });
});

describe('easeOutCubic', () => {
    it('starts at 0 and ends at 1', () => {
        expect(easeOutCubic(0)).toBe(0);
        expect(easeOutCubic(1)).toBe(1);
    });

    it('is monotonically increasing on [0, 1]', () => {
        for (let i = 1; i <= 10; i += 1) {
            const prev = easeOutCubic((i - 1) / 10);
            const curr = easeOutCubic(i / 10);
            expect(curr).toBeGreaterThan(prev);
        }
    });
});

describe('trailOpacity', () => {
    it('returns peak before elapsed = 0', () => {
        expect(trailOpacity(-10, 1000)).toBeCloseTo(0.95);
    });

    it('returns 0 once elapsed exceeds duration', () => {
        expect(trailOpacity(1100, 1000)).toBe(0);
    });

    it('decays from peak to 0', () => {
        expect(trailOpacity(0, 1000)).toBeCloseTo(0.95);
        expect(trailOpacity(1000, 1000)).toBe(0);
        expect(trailOpacity(500, 1000)).toBeGreaterThan(0);
        expect(trailOpacity(500, 1000)).toBeLessThan(0.95);
    });

    it('respects a custom peak', () => {
        expect(trailOpacity(0, 1000, 0.5)).toBeCloseTo(0.5);
    });
});