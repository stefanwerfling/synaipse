import {describe, it, expect} from 'vitest';
import {nodesInsideGroup} from '../src/CanvasRenderer.js';

const rect = (id: string, x: number, y: number, w: number, h: number) =>
    ({id, x, y, width: w, height: h});

describe('nodesInsideGroup', () => {
    const group = rect('g1', 100, 100, 400, 300);

    it('excludes the group itself', () => {
        expect(nodesInsideGroup(group, [group])).toEqual([]);
    });

    it('returns nodes fully inside the group rect', () => {
        const inside = rect('a', 150, 150, 80, 60);
        const outside = rect('b', 600, 600, 80, 60);
        const result = nodesInsideGroup(group, [inside, outside]);
        expect(result.map((n) => n.id)).toEqual(['a']);
    });

    it('includes nodes flush with the group edge (edge-inclusive)', () => {
        const flush = rect('a', 100, 100, 400, 300);
        expect(nodesInsideGroup(group, [flush]).map((n) => n.id)).toEqual(['a']);
    });

    it('excludes nodes that partially overlap', () => {
        const straddleTop = rect('a', 200, 80, 80, 60);
        const straddleRight = rect('b', 450, 200, 100, 60);
        const containsGroup = rect('c', 0, 0, 800, 800);
        const result = nodesInsideGroup(group, [straddleTop, straddleRight, containsGroup]);
        expect(result).toEqual([]);
    });

    it('pulls in nested sub-groups (children of a sub-group are also inside)', () => {
        const subGroup = rect('sub', 120, 120, 200, 150);
        const grandChild = rect('gc', 140, 140, 40, 40);
        const result = nodesInsideGroup(group, [subGroup, grandChild]);
        expect(result.map((n) => n.id).sort()).toEqual(['gc', 'sub']);
    });
});