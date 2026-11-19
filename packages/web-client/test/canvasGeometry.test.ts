import {describe, expect, it} from 'vitest';
import type {CanvasDocument} from '@synaipse/core';
import {CanvasCamera} from '../src/CanvasCamera.js';
import {
    anchorFor,
    arrowStyleOf,
    bezierMidpoint,
    computeBounds,
    nodesOverlapping,
    resolveColor,
    snap,
    withEdgeArrow,
    withEdgeLabel,
    withGroupLabel,
    withNodesColor,
    withoutNodes,
    withRerouted
} from '../src/CanvasGeometry.js';
import {CanvasHistory} from '../src/CanvasHistory.js';

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

    it('anchors on the stored side, or the side facing the other node', () => {
        const [a, b] = doc().nodes;
        expect(anchorFor(a!, undefined, b!)).toEqual({x: 100, y: 50, side: 'right'});
        expect(anchorFor(a!, 'top', b!)).toEqual({x: 50, y: 0, side: 'top'});
        const mid = bezierMidpoint(anchorFor(a!, undefined, b!), anchorFor(b!, undefined, a!));
        expect(mid).toEqual({x: 200, y: 50});
    });

    it('bounds and overlap', () => {
        expect(computeBounds(doc().nodes)).toEqual({minX: -20, minY: -20, maxX: 480, maxY: 180});
        expect(computeBounds([])).toEqual({minX: 0, minY: 0, maxX: 800, maxY: 600});
        expect(nodesOverlapping(doc().nodes, 90, 90, 95, 95)).toEqual(['a', 'g']);
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

describe('CanvasHistory', () => {
    it('undo/redo walk the committed states and a new record clears redo', () => {
        const d0 = doc();
        const h = new CanvasHistory(d0);
        const d1 = withoutNodes(d0, ['a']);
        h.record(d1);
        const d2 = withoutNodes(d1, ['b']);
        h.record(d2);

        expect(h.undo()!.nodes.map((n) => n.id)).toEqual(['b', 'g']);
        expect(h.undo()!.nodes.map((n) => n.id)).toEqual(['a', 'b', 'g']);
        expect(h.undo()).toBeUndefined();
        expect(h.redo()!.nodes.map((n) => n.id)).toEqual(['b', 'g']);

        h.record(d0);
        expect(h.redo()).toBeUndefined();
    });

    it('snapshots do not share references with the live doc', () => {
        const live = doc();
        const h = new CanvasHistory(live);
        h.record(live);
        live.nodes[0]!.x = 999; // in-place drag mutation
        expect(h.undo()!.nodes[0]!.x).toBe(0);
    });

    it('caps the undo stack', () => {
        const h = new CanvasHistory(doc(), 2);
        for (let i = 0; i < 5; i++) h.record(doc());
        expect(h.undo()).toBeDefined();
        expect(h.undo()).toBeDefined();
        expect(h.undo()).toBeUndefined();
    });
});

describe('CanvasCamera', () => {
    it('zooms around the cursor and pans relative to the start', () => {
        const cam = new CanvasCamera();
        cam.zoomAt(100, 50, true);
        expect(cam.toWorld(100, 50).x).toBeCloseTo(100);
        expect(cam.toWorld(100, 50).y).toBeCloseTo(50);

        cam.startPan(0, 0);
        cam.panTo(10, -5);
        expect(cam.panning).toBe(true);
        cam.endPan();
        expect(cam.panning).toBe(false);
        expect(cam.tx).toBeCloseTo(100 - 100 * 1.15 + 10);
    });

    it('fit centres the bounds at 90 % and clamps the scale', () => {
        const cam = new CanvasCamera();
        cam.fit({minX: 0, minY: 0, maxX: 1000, maxY: 500}, 1000, 1000);
        expect(cam.scale).toBeCloseTo(0.9);
        expect(cam.toWorld(500, 500).x).toBeCloseTo(500);
        cam.fit({minX: 0, minY: 0, maxX: 1, maxY: 1}, 1000, 1000);
        expect(cam.scale).toBe(4);
    });
});
