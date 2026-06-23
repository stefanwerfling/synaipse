import {describe, it, expect} from 'vitest';
import type {Note, NoteId, SearchHit} from '@synaipse/core';
import {buildAdjacency, graphProximityScore, rankByGraphProximity} from '../src/Graph.js';

const note = (
    id: NoteId,
    opts: {wikilinks?: string[]; backlinks?: NoteId[]; title?: string} = {}
): Note => ({
    id,
    path: id,
    title: opts.title ?? id,
    content: '',
    frontmatter: {},
    tags: [],
    wikilinks: opts.wikilinks ?? [],
    backlinks: opts.backlinks ?? [],
    mtime: 0,
    hash: 'h'
});

const hit = (id: NoteId): SearchHit => ({noteId: id, path: id, title: id, score: 1});

const titleResolver = (notes: readonly Note[]) => {
    const map = new Map<string, NoteId>();
    for (const n of notes) {
        if (!map.has(n.title)) map.set(n.title, n.id);
    }
    return (key: string) => map.get(key);
};

describe('buildAdjacency', () => {
    it('returns empty neighbour sets for a vault with no links', () => {
        const notes = [note('a'), note('b')];
        const adj = buildAdjacency(notes, titleResolver(notes));

        expect(adj.degree('a')).toBe(0);
        expect(adj.degree('b')).toBe(0);
        expect([...adj.neighbors('a')]).toEqual([]);
    });

    it('treats wikilinks as undirected — both endpoints see each other', () => {
        const notes = [note('a', {wikilinks: ['b']}), note('b')];
        const adj = buildAdjacency(notes, titleResolver(notes));

        expect(adj.neighbors('a').has('b')).toBe(true);
        expect(adj.neighbors('b').has('a')).toBe(true);
    });

    it('skips wikilinks that do not resolve to a known note', () => {
        const notes = [note('a', {wikilinks: ['b', 'missing-title']})];
        const adj = buildAdjacency(notes, titleResolver([...notes, note('b')]));

        expect(adj.neighbors('a').size).toBe(1);
        expect(adj.neighbors('a').has('b')).toBe(true);
    });

    it('drops self-links rather than inflating degree', () => {
        const notes = [note('a', {wikilinks: ['a']})];
        const adj = buildAdjacency(notes, titleResolver(notes));

        expect(adj.degree('a')).toBe(0);
    });

    it('unions wikilinks and backlinks so already-known incoming links count', () => {
        const notes = [note('a', {backlinks: ['b']}), note('b')];
        const adj = buildAdjacency(notes, titleResolver(notes));

        expect(adj.neighbors('a').has('b')).toBe(true);
        expect(adj.neighbors('b').has('a')).toBe(true);
    });

    it('degree reflects the union size, not the wikilink-list size', () => {
        const notes = [
            note('hub', {wikilinks: ['a', 'b', 'c']}),
            note('a'),
            note('b'),
            note('c')
        ];
        const adj = buildAdjacency(notes, titleResolver(notes));
        expect(adj.degree('hub')).toBe(3);
    });
});

describe('graphProximityScore', () => {
    it('returns 0 when seed set is empty', () => {
        const notes = [note('a', {wikilinks: ['b']}), note('b')];
        const adj = buildAdjacency(notes, titleResolver(notes));
        expect(graphProximityScore('a', [], adj)).toBe(0);
    });

    it('returns 0 for a candidate disconnected from every seed', () => {
        const notes = [note('seed'), note('iso')];
        const adj = buildAdjacency(notes, titleResolver(notes));
        expect(graphProximityScore('iso', ['seed'], adj)).toBe(0);
    });

    it('awards the self-bonus when the candidate IS a seed', () => {
        const notes = [note('a')];
        const adj = buildAdjacency(notes, titleResolver(notes));
        expect(graphProximityScore('a', ['a'], adj, {seedSelfBonus: 1.0})).toBe(1.0);
    });

    it('awards the direct-link bonus when the candidate is a 1-hop neighbour', () => {
        const notes = [note('seed', {wikilinks: ['hit']}), note('hit')];
        const adj = buildAdjacency(notes, titleResolver(notes));
        expect(graphProximityScore('hit', ['seed'], adj, {
            directLinkBonus: 0.5,
            seedSelfBonus: 0
        })).toBe(0.5);
    });

    it('adds Adamic-Adar contribution for each shared common neighbour', () => {
        // seed → mid ← hit  (mid is a degree-2 common neighbour)
        const notes = [
            note('seed', {wikilinks: ['mid']}),
            note('hit', {wikilinks: ['mid']}),
            note('mid')
        ];
        const adj = buildAdjacency(notes, titleResolver(notes));
        const score = graphProximityScore('hit', ['seed'], adj, {
            directLinkBonus: 0,
            seedSelfBonus: 0
        });
        // mid has degree 2 → contribution = 1 / log(2 + e) ≈ 0.671
        expect(score).toBeCloseTo(1 / Math.log(2 + Math.E), 5);
    });

    it('skips common neighbours whose degree exceeds the heavy cap', () => {
        // hub is a heavy crawler-index-like node connected to many notes.
        const notes = [
            note('seed', {wikilinks: ['hub']}),
            note('hit', {wikilinks: ['hub']}),
            note('hub', {wikilinks: ['n1', 'n2', 'n3', 'n4', 'n5']}),
            note('n1'), note('n2'), note('n3'), note('n4'), note('n5')
        ];
        const adj = buildAdjacency(notes, titleResolver(notes));

        // hub has degree 7 (seed, hit, n1..n5). Cap at 5 → hub is skipped.
        const skipped = graphProximityScore('hit', ['seed'], adj, {
            heavyDegreeCap: 5,
            directLinkBonus: 0,
            seedSelfBonus: 0
        });
        expect(skipped).toBe(0);

        // Without the cap, the AA contribution is non-zero.
        const counted = graphProximityScore('hit', ['seed'], adj, {
            heavyDegreeCap: 100,
            directLinkBonus: 0,
            seedSelfBonus: 0
        });
        expect(counted).toBeGreaterThan(0);
    });

    it('sums contributions across multiple seeds', () => {
        const notes = [
            note('s1', {wikilinks: ['hit']}),
            note('s2', {wikilinks: ['hit']}),
            note('hit')
        ];
        const adj = buildAdjacency(notes, titleResolver(notes));
        const score = graphProximityScore('hit', ['s1', 's2'], adj, {
            directLinkBonus: 0.5,
            seedSelfBonus: 0
        });
        expect(score).toBe(1.0);
    });
});

describe('rankByGraphProximity', () => {
    it('orders candidates by descending proximity score', () => {
        // seed → {near, mid, bridge}; near → bridge; far → bridge
        //   near  → direct + AA via bridge
        //   mid   → direct only
        //   far   → AA via bridge only
        const notes = [
            note('seed', {wikilinks: ['near', 'mid', 'bridge']}),
            note('near', {wikilinks: ['bridge']}),
            note('mid'),
            note('far', {wikilinks: ['bridge']}),
            note('bridge')
        ];
        const adj = buildAdjacency(notes, titleResolver(notes));

        const ranked = rankByGraphProximity(
            [hit('far'), hit('mid'), hit('near')],
            ['seed'],
            adj
        );
        expect(ranked.map((h) => h.noteId)).toEqual(['near', 'mid', 'far']);
    });

    it('drops candidates with zero proximity', () => {
        const notes = [note('seed'), note('iso')];
        const adj = buildAdjacency(notes, titleResolver(notes));

        const ranked = rankByGraphProximity([hit('iso')], ['seed'], adj);
        expect(ranked).toEqual([]);
    });

    it('dedupes candidates that appear multiple times', () => {
        const notes = [note('seed', {wikilinks: ['a']}), note('a')];
        const adj = buildAdjacency(notes, titleResolver(notes));

        const ranked = rankByGraphProximity([hit('a'), hit('a')], ['seed'], adj);
        expect(ranked).toHaveLength(1);
    });

    it('returns an empty list when seeds are empty', () => {
        const notes = [note('a', {wikilinks: ['b']}), note('b')];
        const adj = buildAdjacency(notes, titleResolver(notes));

        expect(rankByGraphProximity([hit('a'), hit('b')], [], adj)).toEqual([]);
    });

    it('replaces hit.score with the proximity score in the returned list', () => {
        const notes = [note('seed', {wikilinks: ['hit']}), note('hit')];
        const adj = buildAdjacency(notes, titleResolver(notes));

        const original = {noteId: 'hit', path: 'hit', title: 'hit', score: 99} as const;
        const [ranked] = rankByGraphProximity([original], ['seed'], adj);
        expect(ranked?.score).not.toBe(99);
        expect(ranked?.score).toBeGreaterThan(0);
    });
});