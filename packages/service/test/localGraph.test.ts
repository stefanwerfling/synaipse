import {describe, expect, it} from 'vitest';
import type {Graph, TypedLinkKind} from '@synaipse/core';
import {buildLocalGraph} from '../src/LocalGraph.js';

const graph = (edges: Array<[string, string]>, extraNodes: string[] = []): Graph => {
    const ids = new Set<string>(extraNodes);
    for (const [a, b] of edges) {
        ids.add(a);
        ids.add(b);
    }
    return {
        nodes: [...ids].map((id) => ({id, title: id.toUpperCase(), tags: []})),
        edges: edges.map(([from, to]) => ({from, to, kind: 'wikilink' as const}))
    };
};

const noTyped = (): ReadonlyArray<{to: string; kind: TypedLinkKind}> => [];

describe('buildLocalGraph', () => {
    // a -> b -> c -> d, x -> a, island
    const g = graph([['a', 'b'], ['b', 'c'], ['c', 'd'], ['x', 'a']], ['island']);

    it('returns null for an unknown center', () => {
        expect(buildLocalGraph(g, noTyped, 'nope')).toBeNull();
    });

    it('depth 1 takes links in both directions and only edges among the picked nodes', () => {
        const local = buildLocalGraph(g, noTyped, 'a')!;

        expect(local.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'x']);
        expect(local.nodes.find((n) => n.id === 'a')?.hop).toBe(0);
        expect(local.edges).toEqual(expect.arrayContaining([
            {from: 'a', to: 'b', kind: 'wikilink'},
            {from: 'x', to: 'a', kind: 'wikilink'}
        ]));
        expect(local.edges).toHaveLength(2);
        expect(local.truncated).toBe(false);
    });

    it('depth 2 adds the second ring with hop numbers', () => {
        const local = buildLocalGraph(g, noTyped, 'a', {depth: 2})!;

        expect(local.nodes.find((n) => n.id === 'c')?.hop).toBe(2);
        expect(local.nodes.some((n) => n.id === 'd')).toBe(false);
    });

    it('a node limit truncates, keeping the best-connected neighbours', () => {
        // hub links to h1..h5; h1 and h2 have extra links, so they rank first.
        const hub = graph([
            ['hub', 'h1'], ['hub', 'h2'], ['hub', 'h3'], ['hub', 'h4'], ['hub', 'h5'],
            ['h1', 'y1'], ['h1', 'y2'], ['h2', 'y3']
        ]);
        const local = buildLocalGraph(hub, noTyped, 'hub', {limit: 3})!;

        expect(local.truncated).toBe(true);
        expect(local.nodes.map((n) => n.id)).toEqual(['hub', 'h1', 'h2']);
    });

    it('typed frontmatter links add nodes and typed edges', () => {
        const typed = (id: string) => id === 'a' ? [{to: 'd', kind: 'supersedes' as const}, {to: 'ghost', kind: 'relates_to' as const}] : [];
        const local = buildLocalGraph(g, typed, 'a')!;

        expect(local.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'd', 'x']);
        expect(local.edges).toContainEqual({from: 'a', to: 'd', kind: 'supersedes'});
        expect(local.edges.some((e) => e.to === 'ghost')).toBe(false);
    });

    it('clamps depth and limit to sane bounds', () => {
        const local = buildLocalGraph(g, noTyped, 'a', {depth: 99, limit: 0})!;

        expect(local.nodes).toHaveLength(1);
        expect(local.truncated).toBe(true);
    });
});
