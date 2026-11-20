import {describe, expect, it} from 'vitest';
import type {CanvasDocument} from '@synaipse/core';
import {
    arrowStyleOf,
    resolveColor,
    snap,
    withEdgeArrow,
    withEdgeLabel,
    withGroupLabel,
    withNodesColor,
    withoutNodes,
    withRerouted
} from '../src/CanvasGeometry.js';

const doc = (): CanvasDocument => ({
    nodes: [
        {id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 100, text: 'A', color: '1'},
        {id: 'b', type: 'text', x: 300, y: 0, width: 100, height: 100, text: 'B'},
        {id: 'g', type: 'group', x: -20, y: -20, width: 500, height: 200, label: 'G'}
    ],
    edges: [{id: 'e', fromNode: 'a', toNode: 'b', toEnd: 'arrow'}]
});

describe('CanvasGeometry (plan P7 / D2)', () => {
    it('snaps to the 20px grid and resolves colour presets', () => {
        expect(snap(29)).toBe(20);
        expect(snap(31)).toBe(40);
        expect(resolveColor('5', 'x')).toBe('#6f9fc4');
        expect(resolveColor('#123456', 'x')).toBe('#123456');
        expect(resolveColor(undefined, 'x')).toBe('x');
    });

    it('arrow style round-trips through withEdgeArrow', () => {
        for (const style of ['to', 'both', 'none'] as const) {
            expect(arrowStyleOf(withEdgeArrow(doc(), 'e', style).edges[0]!)).toBe(style);
        }
    });

    it('document operations return new documents and leave the input alone', () => {
        const before = doc();
        const cleared = withNodesColor(before, ['a'], undefined);
        expect(cleared.nodes[0]).not.toHaveProperty('color');
        expect(before.nodes[0]!.color).toBe('1');

        expect(withEdgeLabel(before, 'e', 'x').edges[0]!.label).toBe('x');
        expect(withGroupLabel(before, 'g', '').nodes[2]).not.toHaveProperty('label');
        expect(withGroupLabel(before, 'a', 'nope').nodes[0]).toEqual(before.nodes[0]);

        const dropped = withoutNodes(before, ['a']);
        expect(dropped.nodes.map((n) => n.id)).toEqual(['b', 'g']);
        expect(dropped.edges).toEqual([]);
    });

    it('reroute rejects self-loops', () => {
        expect(withRerouted(doc(), 'e', 'to', 'a').edges[0]!.toNode).toBe('b');
        expect(withRerouted(doc(), 'e', 'from', 'g').edges[0]!.fromNode).toBe('g');
    });
});
