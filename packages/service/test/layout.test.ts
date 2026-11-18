import {describe, expect, it} from 'vitest';
import {computeLayout, packCircles, tileRadius, type PackCircle} from '../src/Layout.js';

const overlapping = (circles: ReadonlyArray<{x: number; y: number; r: number}>): number => {
    let count = 0;
    for (let a = 0; a < circles.length; a++) {
        for (let b = a + 1; b < circles.length; b++) {
            const p = circles[a]!;
            const q = circles[b]!;
            if (Math.hypot(p.x - q.x, p.y - q.y) < p.r + q.r - 1e-3) count++;
        }
    }
    return count;
};

/** `groups` cliques of `size`, every clique linked to the next once, plus `loose` notes without links. */
const vault = (groups: number, size: number, loose: number) => {
    const nodes: Array<{id: string}> = [];
    const edges: Array<{from: string; to: string}> = [];

    for (let g = 0; g < groups; g++) {
        for (let i = 0; i < size; i++) {
            nodes.push({id: `${g}.${i}`});
            for (let j = 0; j < i; j++) edges.push({from: `${g}.${i}`, to: `${g}.${j}`});
        }
        if (g > 0) edges.push({from: `${g}.0`, to: `${g - 1}.1`});
    }

    for (let i = 0; i < loose; i++) nodes.push({id: `loose${i}`});
    return {nodes, edges};
};

describe('packCircles', () => {
    it('packs circles of mixed size without overlap, roughly round', () => {
        let seed = 9;
        const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        const circles: PackCircle[] = Array.from({length: 400}, () => ({r: 10 + rnd() * rnd() * 200, x: 0, y: 0}))
            .sort((a, b) => b.r - a.r);

        packCircles(circles);

        expect(overlapping(circles)).toBe(0);
        const xs = circles.map((c) => c.x);
        const ys = circles.map((c) => c.y);
        const w = Math.max(...xs) - Math.min(...xs);
        const h = Math.max(...ys) - Math.min(...ys);
        expect(Math.max(w, h) / Math.min(w, h)).toBeLessThan(1.5);
    });

    it('handles one, two and three circles', () => {
        const one = [{r: 5, x: 9, y: 9}];
        packCircles(one);
        expect(one[0]).toEqual({r: 5, x: 0, y: 0});

        const three = [{r: 5, x: 0, y: 0}, {r: 3, x: 0, y: 0}, {r: 2, x: 0, y: 0}];
        packCircles(three);
        expect(overlapping(three)).toBe(0);
        expect(Math.hypot(three[0]!.x - three[1]!.x, three[0]!.y - three[1]!.y)).toBeCloseTo(8, 6);
    });
});

describe('computeLayout packing', () => {
    it('puts notes without links into one group instead of one tile each', () => {
        const layout = computeLayout(vault(6, 5, 40));
        const unlinked = layout.communities.filter((c) => c.unlinked === true);

        expect(unlinked).toHaveLength(1);
        expect(unlinked[0]!.size).toBe(40);
        expect(layout.communities).toHaveLength(7);
        expect(layout.communities.at(-1)?.unlinked).toBe(true);
        expect(layout.nodes.filter((n) => n.community === unlinked[0]!.id)).toHaveLength(40);
    });

    it('keeps tiles apart, inside the bounds and near-square', () => {
        const layout = computeLayout(vault(60, 6, 100));
        const tiles = layout.communities.map((c) => ({x: c.cx, y: c.cy, r: c.radius}));

        expect(overlapping(tiles)).toBe(0);

        for (const n of layout.nodes) {
            expect(n.x).toBeGreaterThanOrEqual(0);
            expect(n.y).toBeGreaterThanOrEqual(0);
            expect(n.x).toBeLessThanOrEqual(layout.bounds.width);
            expect(n.y).toBeLessThanOrEqual(layout.bounds.height);
        }

        const ratio = layout.bounds.width / layout.bounds.height;
        expect(Math.max(ratio, 1 / ratio)).toBeLessThan(1.6);
    });

    it('sizes tiles by member count and puts the best-connected note in the middle', () => {
        // A path of six notes (degree <= 3 with the hub) and a hub linked to all of them.
        const input = {nodes: [{id: 'hub'}], edges: [] as Array<{from: string; to: string}>};
        for (let i = 0; i < 6; i++) {
            input.nodes.push({id: `p${i}`});
            input.edges.push({from: 'hub', to: `p${i}`});
            if (i > 0) input.edges.push({from: `p${i - 1}`, to: `p${i}`});
        }
        const layout = computeLayout(input);
        const hub = layout.nodes.find((n) => n.id === 'hub')!;
        const tile = layout.communities.find((c) => c.id === hub.community)!;
        const members = layout.nodes.filter((n) => n.community === tile.id);
        const dist = (n: {x: number; y: number}): number => Math.hypot(n.x - tile.cx, n.y - tile.cy);

        expect(members.length).toBeGreaterThan(1);
        expect(tile.size).toBe(members.length);
        expect(tile.radius).toBeCloseTo(tileRadius(members.length), 6);
        expect(Math.min(...members.map(dist))).toBe(dist(hub));
    });

    it('is deterministic', () => {
        expect(computeLayout(vault(20, 4, 10))).toEqual(computeLayout(vault(20, 4, 10)));
    });
});
