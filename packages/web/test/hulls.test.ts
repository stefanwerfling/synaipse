import {describe, it, expect} from 'vitest';
import {centroid, convexHull, expandHull, toSvgPoints} from '../src/Hulls.js';
import type {Point} from '../src/Hulls.js';

describe('convexHull', () => {
    it('returns input for ≤ 1 point', () => {
        expect(convexHull([])).toEqual([]);
        expect(convexHull([[1, 1]])).toEqual([[1, 1]]);
    });

    it('handles a simple triangle', () => {
        const tri: Point[] = [[0, 0], [4, 0], [2, 3]];
        const hull = convexHull(tri);
        expect(hull.length).toBe(3);

        for (const p of tri) {
            expect(hull).toContainEqual(p);
        }
    });

    it('drops interior points from a square + center', () => {
        const pts: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]];
        const hull = convexHull(pts);

        expect(hull).not.toContainEqual([5, 5]);
        expect(hull.length).toBe(4);
    });

    it('handles collinear points by keeping only the extremes', () => {
        const pts: Point[] = [[0, 0], [1, 0], [2, 0], [3, 0]];
        const hull = convexHull(pts);
        const xs = hull.map((p) => p[0]).sort((a, b) => a - b);

        expect(xs[0]).toBe(0);
        expect(xs[xs.length - 1]).toBe(3);
        expect(hull.length).toBeLessThanOrEqual(2);
    });
});

describe('centroid', () => {
    it('averages coordinates', () => {
        expect(centroid([[0, 0], [4, 0], [2, 6]])).toEqual([2, 2]);
    });

    it('returns origin for empty input', () => {
        expect(centroid([])).toEqual([0, 0]);
    });
});

describe('expandHull', () => {
    it('returns hull unchanged for fewer than 3 vertices', () => {
        expect(expandHull([[0, 0]], 5)).toEqual([[0, 0]]);
        expect(expandHull([[0, 0], [10, 0]], 5)).toEqual([[0, 0], [10, 0]]);
    });

    it('pushes vertices outward from centroid', () => {
        const square: Point[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        const expanded = expandHull(square, 1);

        for (let i = 0; i < square.length; i += 1) {
            const dist = Math.hypot(expanded[i]![0], expanded[i]![1]);
            expect(dist).toBeGreaterThan(Math.hypot(square[i]![0], square[i]![1]));
        }
    });

    it('preserves vertex count', () => {
        const square: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
        expect(expandHull(square, 4).length).toBe(square.length);
    });
});

describe('toSvgPoints', () => {
    it('formats with 1-decimal precision', () => {
        expect(toSvgPoints([[1, 2], [3.456, 7.891]])).toBe('1.0,2.0 3.5,7.9');
    });

    it('handles empty array', () => {
        expect(toSvgPoints([])).toBe('');
    });
});