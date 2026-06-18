import {describe, it, expect} from 'vitest';
import type {ElementDefinition} from 'cytoscape';
import {resolvePositions} from '../src/Graph.js';

const node = (id: string): ElementDefinition => ({data: {id}});
const edge = (id: string, source: string, target: string): ElementDefinition => ({
    data: {id, source, target}
});

describe('resolvePositions', () => {
    it('returns saved positions verbatim', () => {
        const elements = [node('a'), node('b')];
        const saved = {a: {x: 10, y: 20}, b: {x: -5, y: 7}};

        const out = resolvePositions(elements, saved);

        expect(out.get('a')).toEqual({x: 10, y: 20});
        expect(out.get('b')).toEqual({x: -5, y: 7});
    });

    it('places a new node at the centroid of its placed neighbours', () => {
        const elements = [
            node('a'),
            node('b'),
            node('c'),
            edge('e0', 'a', 'c'),
            edge('e1', 'b', 'c')
        ];
        const saved = {a: {x: 0, y: 0}, b: {x: 100, y: 0}};

        const out = resolvePositions(elements, saved);

        const c = out.get('c');
        expect(c).toBeDefined();
        // centroid is (50,0); jitter ring of radius 18 keeps it within that distance
        expect(Math.hypot(c!.x - 50, c!.y - 0)).toBeLessThanOrEqual(18.0001);
    });

    it('places orphan new nodes deterministically on a spiral', () => {
        const elements = [node('a'), node('b'), node('c')];

        const out = resolvePositions(elements, {});

        const a = out.get('a')!;
        const b = out.get('b')!;
        const c = out.get('c')!;

        // each on a different point — no two nodes at the same location
        expect(a).not.toEqual(b);
        expect(b).not.toEqual(c);
        expect(a).not.toEqual(c);

        // and within a reasonable radius of origin
        expect(Math.hypot(a.x, a.y)).toBeLessThan(200);
        expect(Math.hypot(c.x, c.y)).toBeLessThan(200);
    });

    it('produces a position for every visible node', () => {
        const elements = [node('a'), node('b'), node('c'), edge('e', 'a', 'b')];

        const out = resolvePositions(elements, {a: {x: 0, y: 0}});

        expect(out.has('a')).toBe(true);
        expect(out.has('b')).toBe(true);
        expect(out.has('c')).toBe(true);
    });

    it('ignores self-loops when computing the centroid', () => {
        // c links to itself; should not affect placement
        const elements = [node('a'), node('c'), edge('e0', 'a', 'c'), edge('e1', 'c', 'c')];
        const saved = {a: {x: 40, y: 80}};

        const out = resolvePositions(elements, saved);

        const c = out.get('c')!;
        // centroid of {a} is (40, 80) + jitter ≤ 18
        expect(Math.hypot(c.x - 40, c.y - 80)).toBeLessThanOrEqual(18.0001);
    });

    it('is deterministic — same input yields same output', () => {
        const elements = [node('a'), node('b'), node('c')];

        const out1 = resolvePositions(elements, {});
        const out2 = resolvePositions(elements, {});

        expect(out1).toEqual(out2);
    });

    it('handles an empty graph', () => {
        expect(resolvePositions([], {})).toEqual(new Map());
    });
});