import {describe, expect, it} from 'vitest';
import {detectCommunities, type CommunityGraphEdge} from '../src/Louvain.js';

/** `count` cliques of `size` nodes, neighbouring cliques joined by one edge (a ring). */
const ringOfCliques = (count: number, size: number): {nodes: Array<{id: string}>; edges: CommunityGraphEdge[]} => {
    const nodes: Array<{id: string}> = [];
    const edges: CommunityGraphEdge[] = [];

    for (let c = 0; c < count; c++) {
        for (let i = 0; i < size; i++) {
            nodes.push({id: `${c}.${i}`});

            for (let j = 0; j < i; j++) edges.push({from: `${c}.${i}`, to: `${c}.${j}`});
        }

        edges.push({from: `${c}.0`, to: `${(c + 1) % count}.1`});
    }

    return {nodes, edges};
};

/** Reference modularity straight from the definition, on the original edges. */
const modularityOf = (edges: CommunityGraphEdge[], partition: Map<string, number>): number => {
    const m = edges.length;
    const degree = new Map<string, number>();
    const inside = new Map<number, number>();
    const total = new Map<number, number>();

    for (const e of edges) {
        degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
        degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
        const c = partition.get(e.from) as number;
        if (c === partition.get(e.to)) inside.set(c, (inside.get(c) ?? 0) + 1);
    }

    for (const [id, k] of degree) {
        const c = partition.get(id) as number;
        total.set(c, (total.get(c) ?? 0) + k);
    }

    let q = 0;
    for (const [c, t] of total) q += (inside.get(c) ?? 0) / m - (t / (2 * m)) ** 2;
    return q;
};

describe('detectCommunities (Louvain)', () => {
    it('finds each clique of a ring of cliques as its own community', () => {
        const {nodes, edges} = ringOfCliques(12, 6);
        const result = detectCommunities(nodes, edges);

        expect(result.count).toBe(12);
        expect(result.sizes).toEqual(Array(12).fill(6));

        for (let c = 0; c < 12; c++) {
            const ids = new Set(Array.from({length: 6}, (_, i) => result.partition.get(`${c}.${i}`)));
            expect(ids.size).toBe(1);
        }
    });

    it('reports the modularity of the returned partition', () => {
        const {nodes, edges} = ringOfCliques(12, 6);
        const result = detectCommunities(nodes, edges);

        expect(result.modularity).toBeGreaterThan(0.8);
        expect(result.modularity).toBeCloseTo(modularityOf(edges, result.partition), 10);
    });

    it('does not merge two dense groups joined by one bridge', () => {
        const {nodes, edges} = ringOfCliques(2, 8);
        const result = detectCommunities(nodes, edges);

        expect(result.count).toBe(2);
        expect(result.partition.get('0.3')).not.toBe(result.partition.get('1.3'));
        expect(result.modularity).toBeCloseTo(modularityOf(edges, result.partition), 10);
    });

    it('keeps isolated notes as singletons and handles a graph without edges', () => {
        const result = detectCommunities([{id: 'a'}, {id: 'b'}], []);

        expect(result.count).toBe(2);
        expect(result.modularity).toBe(0);
        expect(detectCommunities([], []).count).toBe(0);
    });

    it('counts self-loops and weights without collapsing everything', () => {
        const {nodes, edges} = ringOfCliques(6, 5);
        const result = detectCommunities(nodes, [...edges, {from: '0.0', to: '0.0', weight: 3}]);

        expect(result.count).toBe(6);
        expect(result.modularity).toBeGreaterThan(0.6);
    });

    it('stays clustered on a sparse random-ish graph with planted groups', () => {
        // 40 groups of 25, ~2 links per note, 90 % inside the group (deterministic LCG).
        let seed = 7;
        const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        const nodes = Array.from({length: 1000}, (_, i) => ({id: `n${i}`}));
        const edges: CommunityGraphEdge[] = [];

        for (let i = 0; i < 1000; i++) {
            for (let k = 0; k < 2; k++) {
                const j = rnd() < 0.9 ? Math.floor(i / 25) * 25 + Math.floor(rnd() * 25) : Math.floor(rnd() * 1000);
                if (j !== i) edges.push({from: `n${i}`, to: `n${j}`});
            }
        }

        const result = detectCommunities(nodes, edges);

        expect(result.sizes[0]).toBeLessThan(100);
        expect(result.count).toBeGreaterThanOrEqual(30);
        expect(result.modularity).toBeGreaterThan(0.7);
        expect(result.modularity).toBeCloseTo(modularityOf(edges, result.partition), 10);
    });
});
