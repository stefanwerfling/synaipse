import {describe, it, expect} from 'vitest';
import type {SearchHit, SearchSignalName} from '@synaipse/core';
import {annotateSingleSignal, defaultDemote, reciprocalRankFusion} from '../src/Fusion.js';

const hit = (id: string, score: number, snippet?: string): SearchHit => ({
    noteId: id,
    path: id,
    title: id,
    score,
    ...(snippet !== undefined ? {snippet} : {})
});

const signal = (name: SearchSignalName, hits: SearchHit[]) => ({name, hits});

describe('reciprocalRankFusion', () => {
    it('returns an empty list when no inputs', () => {
        expect(reciprocalRankFusion([], {limit: 10})).toEqual([]);
    });

    it('passes a single ranking through (order preserved)', () => {
        const fused = reciprocalRankFusion(
            [signal('fulltext', [hit('a', 99), hit('b', 50), hit('c', 1)])],
            {limit: 10}
        );

        expect(fused.map((h) => h.noteId)).toEqual(['a', 'b', 'c']);
    });

    it('promotes documents that appear in BOTH rankings', () => {
        const ft = [hit('only-ft', 100), hit('shared', 1)];
        const sem = [hit('only-sem', 0.9), hit('shared', 0.05)];

        const fused = reciprocalRankFusion(
            [signal('fulltext', ft), signal('semantic', sem)],
            {limit: 5}
        );

        expect(fused[0]?.noteId).toBe('shared');
        expect(fused.slice(1).map((h) => h.noteId).sort()).toEqual(['only-ft', 'only-sem']);
    });

    it('is unaffected by score MAGNITUDE — only rank matters', () => {
        const ft = [hit('top-fulltext-spam', 10000), hit('shared', 50)];
        const sem = [hit('shared', 0.001), hit('semantic-only', 0.0001)];

        const fused = reciprocalRankFusion(
            [signal('fulltext', ft), signal('semantic', sem)],
            {limit: 3}
        );

        expect(fused[0]?.noteId).toBe('shared');
        expect(fused[1]?.noteId).toBe('top-fulltext-spam');
    });

    it('respects the limit', () => {
        const list = [hit('a', 1), hit('b', 1), hit('c', 1), hit('d', 1)];
        expect(reciprocalRankFusion([signal('fulltext', list)], {limit: 2})).toHaveLength(2);
    });

    it('demote callback can downweight specific hits', () => {
        const ft = [hit('a', 1), hit('b', 1)];
        const sem = [hit('a', 1), hit('b', 1)];

        const fused = reciprocalRankFusion(
            [signal('fulltext', ft), signal('semantic', sem)],
            {
                limit: 5,
                weightFor: (h) => h.noteId === 'a' ? 0.3 : 1
            }
        );

        expect(fused[0]?.noteId).toBe('b');
        expect(fused[1]?.noteId).toBe('a');
    });

    it('prefers a snippet from whichever ranking carried one', () => {
        const ft = [hit('a', 1)];
        const sem = [hit('a', 1, 'semantic snippet')];

        const [merged] = reciprocalRankFusion(
            [signal('fulltext', ft), signal('semantic', sem)],
            {limit: 1}
        );
        expect(merged?.snippet).toBe('semantic snippet');
    });

    it('populates components with per-signal score + rank for every contributor', () => {
        const ft = [hit('a', 12.5), hit('b', 8)];
        const sem = [hit('b', 0.91), hit('c', 0.40)];
        const tit = [hit('a', 1.0)];

        const fused = reciprocalRankFusion(
            [signal('title', tit), signal('semantic', sem), signal('fulltext', ft)],
            {limit: 5}
        );

        const byId = new Map(fused.map((h) => [h.noteId, h]));

        expect(byId.get('a')?.components).toEqual({
            title: {score: 1.0, rank: 1},
            fulltext: {score: 12.5, rank: 1}
        });
        expect(byId.get('b')?.components).toEqual({
            semantic: {score: 0.91, rank: 1},
            fulltext: {score: 8, rank: 2}
        });
        expect(byId.get('c')?.components).toEqual({
            semantic: {score: 0.40, rank: 2}
        });
    });

    it('records demote multiplier in components when < 1', () => {
        const ft = [hit('demoted', 1), hit('normal', 1)];

        const fused = reciprocalRankFusion(
            [signal('fulltext', ft)],
            {
                limit: 5,
                weightFor: (h) => h.noteId === 'demoted' ? 0.2 : 1
            }
        );

        const byId = new Map(fused.map((h) => [h.noteId, h]));
        expect(byId.get('demoted')?.components?.demote).toBe(0.2);
        expect(byId.get('normal')?.components?.demote).toBeUndefined();
    });
});

describe('annotateSingleSignal', () => {
    it('attaches a single-signal components block with rank from list position', () => {
        const annotated = annotateSingleSignal(
            [hit('a', 12.5), hit('b', 7.1), hit('c', 0.3)],
            'fulltext'
        );

        expect(annotated[0]?.components).toEqual({fulltext: {score: 12.5, rank: 1}});
        expect(annotated[1]?.components).toEqual({fulltext: {score: 7.1, rank: 2}});
        expect(annotated[2]?.components).toEqual({fulltext: {score: 0.3, rank: 3}});
    });

    it('preserves original hit fields including score and snippet', () => {
        const original = hit('a', 5, 'snippet text');
        const [annotated] = annotateSingleSignal([original], 'semantic');

        expect(annotated?.noteId).toBe('a');
        expect(annotated?.score).toBe(5);
        expect(annotated?.snippet).toBe('snippet text');
    });
});

describe('defaultDemote', () => {
    it('halves the weight of /_index.md notes', () => {
        const demote = defaultDemote(() => ({wikilinks: []}));
        expect(demote(hit('Crawler/github/_index.md', 1))).toBe(0.4);
        expect(demote(hit('Memory/foo/decision.md', 1))).toBe(1);
    });

    it('halves the weight of notes with more than 30 wikilinks', () => {
        const heavy = {wikilinks: new Array(40).fill('x') as string[]};
        const light = {wikilinks: ['a', 'b'] as string[]};

        const demote = defaultDemote((id) => id === 'heavy.md' ? heavy : light);

        expect(demote(hit('heavy.md', 1))).toBe(0.5);
        expect(demote(hit('light.md', 1))).toBe(1);
    });

    it('compounds when a note is BOTH an index AND wikilink-heavy', () => {
        const heavy = {wikilinks: new Array(500).fill('x') as string[]};
        const demote = defaultDemote(() => heavy);
        expect(demote(hit('Crawler/foo/_index.md', 1))).toBeCloseTo(0.2, 5);
    });

    it('returns 1 for notes the lookup cannot find', () => {
        const demote = defaultDemote(() => undefined);
        expect(demote(hit('unknown.md', 1))).toBe(1);
    });
});