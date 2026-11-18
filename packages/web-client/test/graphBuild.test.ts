import {describe, it, expect} from 'vitest';
import type {Graph as GraphData} from '@synaipse/core';
import {buildGraph, nodeRadius} from '../src/Graph.js';
import {tagColor, NEUTRAL_COLOR} from '../src/Colors.js';
import type {GraphRendererState} from '../src/GraphRenderer.js';

const note = (id: string, tags: string[] = []): GraphData['nodes'][number] =>
    ({id, title: id.toUpperCase(), tags} as unknown as GraphData['nodes'][number]);

const state = (data: GraphData, patch: Partial<GraphRendererState> = {}): GraphRendererState => ({
    data,
    selectedTags: new Set(),
    hideIsolated: false,
    showHulls: false,
    showHeat: false,
    showRoomGrid: false,
    showCluster: false,
    showCommunities: false,
    ...patch
});

const data: GraphData = {
    nodes: [note('a', ['x']), note('b', ['x']), note('c', ['x', 'y']), note('d'), note('lonely', ['y'])],
    edges: [
        {from: 'a', to: 'b', kind: 'wikilink'},
        {from: 'a', to: 'b', kind: 'wikilink'},
        {from: 'b', to: 'c', kind: 'tag'},
        {from: 'c', to: 'd', kind: 'wikilink'}
    ]
} as GraphData;

describe('buildGraph', () => {
    it('maps notes to dots coloured by their first tag and sized by tag count', () => {
        const built = buildGraph(state(data), null);
        const byId = new Map(built.nodes.map((n) => [n.id, n]));

        expect(byId.get('a')).toMatchObject({label: 'A', shape: 'dot', color: tagColor('x'), size: nodeRadius(1)});
        expect(byId.get('d')?.color).toBe(NEUTRAL_COLOR);
        expect(nodeRadius(0)).toBe(7);
        expect(nodeRadius(5)).toBe(16);
        expect(nodeRadius(12)).toBe(16);
    });

    it('gives duplicate edges stable, distinct ids', () => {
        const ids = buildGraph(state(data), null).edges.map((e) => e.id);

        expect(ids).toEqual(['e:wikilink:a→b', 'e:wikilink:a→b#1', 'e:tag:b→c', 'e:wikilink:c→d']);
    });

    it('applies the tag filter and hides isolated notes', () => {
        const built = buildGraph(state(data, {selectedTags: new Set(['y']), hideIsolated: true}), null);

        // c and lonely carry tag y, but only an edge between two visible notes keeps them.
        expect(built.nodes).toEqual([]);
        expect(built.edges).toEqual([]);
        expect(buildGraph(state(data, {hideIsolated: true}), null).nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('builds a hull per tag with at least three visible notes, only when enabled', () => {
        expect(buildGraph(state(data), null).hulls).toEqual([]);

        const hulls = buildGraph(state(data, {showHulls: true}), null).hulls;

        expect(hulls).toHaveLength(1);
        expect(hulls[0]).toMatchObject({id: 'x', nodeIds: ['a', 'b', 'c'], color: tagColor('x'), label: 'x · 3'});
    });
});
