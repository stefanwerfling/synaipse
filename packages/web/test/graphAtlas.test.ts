import {describe, it, expect} from 'vitest';
import type {Graph as GraphData} from '@synaipse/core';
import type {GraphLayout} from '../src/Api.js';
import {atlasNodeRadius, buildAtlas} from '../src/GraphAtlas.js';
import {tagColor} from '../src/Colors.js';
import {communityColor} from '../src/Communities.js';

const note = (id: string, tags: string[] = []): GraphData['nodes'][number] =>
    ({id, title: id.toUpperCase(), tags} as unknown as GraphData['nodes'][number]);

const data: GraphData = {
    nodes: [note('a', ['x']), note('b'), note('c', ['y']), note('unplaced')],
    edges: [
        {from: 'a', to: 'b', kind: 'wikilink'},
        {from: 'b', to: 'c', kind: 'tag'},
        {from: 'c', to: 'unplaced', kind: 'wikilink'},
        {from: 'a', to: 'a', kind: 'wikilink'}
    ]
} as GraphData;

const layout: GraphLayout = {
    hash: 'h',
    nodes: [
        {id: 'a', x: 10, y: 20, community: 0, degree: 4},
        {id: 'b', x: 30, y: 40, community: 0, degree: 0},
        {id: 'c', x: 500, y: 60, community: 1, degree: 100},
        {id: 'deleted', x: 0, y: 0, community: 1, degree: 1}
    ],
    communities: [
        {id: 0, size: 2, cx: 20, cy: 30, radius: 50},
        {id: 1, size: 2, cx: 500, cy: 60, radius: 40}
    ],
    interCommunityEdges: [{from: 0, to: 1, weight: 3}],
    bounds: {width: 600, height: 100},
    modularity: 0.4
};

describe('buildAtlas', () => {
    it('places notes at the server positions, sized by degree and coloured by tag', () => {
        const atlas = buildAtlas(layout, data, false);
        const byId = new Map(atlas.nodes.map((n) => [n.id, n]));

        expect(byId.get('a')).toMatchObject({label: 'A', shape: 'dot', x: 10, y: 20, color: tagColor('x'), size: atlasNodeRadius(4)});
        expect(atlasNodeRadius(0)).toBe(3);
        expect(atlasNodeRadius(10_000)).toBe(7);
    });

    it('colours by community when communities are on', () => {
        const atlas = buildAtlas(layout, data, true);

        expect(atlas.nodes.find((n) => n.id === 'c')?.color).toBe(communityColor(1));
    });

    it('skips layout entries without a note and edges to unplaced notes or self-loops', () => {
        const atlas = buildAtlas(layout, data, false);

        expect(atlas.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
        expect(atlas.edges.map((e) => `${e.source}-${e.target}`)).toEqual(['a-b', 'b-c']);
        expect(new Set(atlas.edges.map((e) => e.id)).size).toBe(atlas.edges.length);
        expect(atlas.edges.every((e) => e.kind === 'atlas')).toBe(true);
    });

    it('turns communities into clusters with their placed members and weighted edges', () => {
        const atlas = buildAtlas(layout, data, false);

        expect(atlas.clusters).toEqual([
            {id: '0', x: 20, y: 30, size: 2, radius: 50, color: communityColor(0), nodeIds: ['a', 'b']},
            {id: '1', x: 500, y: 60, size: 2, radius: 40, color: communityColor(1), nodeIds: ['c']}
        ]);
        expect(atlas.clusterEdges).toEqual([{source: '0', target: '1', weight: 3}]);
    });
});
