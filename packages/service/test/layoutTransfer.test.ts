import {describe, expect, it} from 'vitest';
import {computeLayout, type GraphInput} from '../src/Layout.js';
import {packGraphInput, transferablesOf, unpackGraphInput} from '../src/LayoutTransfer.js';

const graph = (): GraphInput => {
    const nodes = Array.from({length: 60}, (_, i) => ({id: `Memory/p/n${i}.md`, title: `N${i}`, tags: ['a', 'b'], path: `Memory/p/n${i}.md`}));
    const edges: Array<{from: string; to: string; weight?: number}> = [];
    for (let i = 0; i < 60; i++) {
        edges.push({from: `Memory/p/n${i}.md`, to: `Memory/p/n${(i + 1) % 20 + (i >= 30 ? 30 : 0)}.md`});
        if (i % 7 === 0) edges.push({from: `Memory/p/n${i}.md`, to: `Memory/p/n${(i * 3) % 60}.md`, weight: 2});
    }
    edges.push({from: 'Memory/p/n1.md', to: 'Memory/p/ghost.md'}); // endpoint without a node
    return {nodes, edges};
};

describe('packed layout input (P4 A4)', () => {
    it('round-trips ids, edges and weights; extra fields are dropped', () => {
        const input = graph();
        const packed = packGraphInput(input);
        expect(packed.nodeCount).toBe(60);
        expect(packed.names).toHaveLength(61);
        expect(packed.pairs).toHaveLength(input.edges.length * 2);

        const back = unpackGraphInput(packed);
        expect(back.nodes).toEqual(input.nodes.map((n) => ({id: n.id})));
        expect(back.edges).toEqual(input.edges);
        expect(transferablesOf(packed)).toHaveLength(2);
    });

    it('no weights → no weight array', () => {
        const packed = packGraphInput({nodes: [{id: 'a'}, {id: 'b'}], edges: [{from: 'a', to: 'b'}]});
        expect(packed.weights).toBeNull();
        expect(transferablesOf(packed)).toHaveLength(1);
    });

    it('gives the same layout as the full input', () => {
        const input = graph();
        expect(computeLayout(unpackGraphInput(packGraphInput(input)))).toEqual(computeLayout(input));
    });
});
