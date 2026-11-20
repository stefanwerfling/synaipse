import {describe, expect, it} from 'vitest';
import {computeTagAnchors, makeClusterForce} from '../src/Graph3DCluster.js';
import {
    buildAdjacency,
    buildNodeRecords,
    heatLevel,
    highlightSetFor,
    linkColorForHover,
    type NodeRecord
} from '../src/Graph3DModel.js';

const raw = [
    {id: 'a', title: 'A', tags: ['x']},
    {id: 'b', title: 'B', tags: ['x', 'y', 'z', 'w', 'v', 'u']},
    {id: 'c', title: 'C', tags: []}
];

describe('Graph3DModel (plan P7 / D2)', () => {
    it('radius grows with the tag count, capped at 8', () => {
        const records = buildNodeRecords(raw, new Map(), {});
        expect(records.map((r) => r.radius)).toEqual([5, 8, 4]);
    });

    it('positions: live record > saved snapshot > unset', () => {
        const live: NodeRecord = {id: 'a', title: 'A', tags: [], color: '#000', radius: 4, x: 1, y: 2, z: 3};
        const records = buildNodeRecords(raw, new Map([['a', live]]), {
            a: {x: 9, y: 9, z: 9},
            b: {x: 4, y: 5, z: 6}
        });

        expect([records[0]!.x, records[0]!.y, records[0]!.z]).toEqual([1, 2, 3]);
        expect([records[1]!.x, records[1]!.y, records[1]!.z]).toEqual([4, 5, 6]);
        expect(records[2]).not.toHaveProperty('x');
    });

    it('adjacency is undirected and the highlight set is hover + neighbours', () => {
        const adjacency = buildAdjacency([{source: 'a', target: 'b'}, {source: 'b', target: 'c'}]);
        expect([...adjacency.get('b')!].sort()).toEqual(['a', 'c']);
        expect(highlightSetFor(null, adjacency)).toBeNull();
        expect([...highlightSetFor('a', adjacency)!].sort()).toEqual(['a', 'b']);
        expect([...highlightSetFor('lonely', adjacency)!]).toEqual(['lonely']);
    });

    it('link colour accepts id and live-node endpoints', () => {
        const node = {id: 'a'} as NodeRecord;
        const normal = linkColorForHover({source: 'a', target: 'b'}, null);
        const lit = linkColorForHover({source: node, target: 'b'}, 'a');
        const dim = linkColorForHover({source: 'c', target: 'b'}, 'a');
        expect(new Set([normal, lit, dim]).size).toBe(3);
        expect(linkColorForHover({source: 'b', target: node}, 'a')).toBe(lit);
    });

    it('heat level clamps the raw count to 0..1', () => {
        expect(heatLevel(-1)).toBe(0);
        expect(heatLevel(2.5)).toBe(0.5);
        expect(heatLevel(50)).toBe(1);
    });
});

describe('Graph3DCluster', () => {
    it('places one anchor per tag on a 220-radius sphere', () => {
        const anchors = computeTagAnchors(raw);
        expect([...anchors.keys()]).toEqual(['u', 'v', 'w', 'x', 'y', 'z']);
        for (const p of anchors.values()) {
            expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(220);
        }
        expect(computeTagAnchors([{tags: ['solo']}]).get('solo')).toEqual({x: 220, y: 0, z: 0});
    });

    it('the force pulls velocity toward the primary tag anchor, scaled by alpha', () => {
        const force = makeClusterForce(new Map([['t', {x: 10, y: 0, z: 0}]]));
        const node = {id: 'n', tags: ['t'], x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0};
        const untagged = {id: 'm', tags: [], x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0};
        force.initialize([node, untagged]);
        force(0.5);
        expect(node.vx).toBeCloseTo(10 * 0.18 * 0.5);
        expect(untagged.vx).toBe(0);
    });
});
