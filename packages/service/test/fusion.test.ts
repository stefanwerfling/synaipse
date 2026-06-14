import {describe, it, expect} from 'vitest';
import type {SearchHit} from '@synaipse/core';
import {defaultDemote, reciprocalRankFusion} from '../src/Fusion.js';

const hit = (id: string, score: number, snippet?: string): SearchHit => ({
    noteId: id,
    path: id,
    title: id,
    score,
    ...(snippet !== undefined ? {snippet} : {})
});

describe('reciprocalRankFusion', () => {
    it('returns an empty list when no inputs', () => {
        expect(reciprocalRankFusion([], {limit: 10})).toEqual([]);
    });

    it('passes a single ranking through (order preserved)', () => {
        const fused = reciprocalRankFusion(
            [[hit('a', 99), hit('b', 50), hit('c', 1)]],
            {limit: 10}
        );

        expect(fused.map((h) => h.noteId)).toEqual(['a', 'b', 'c']);
    });

    it('promotes documents that appear in BOTH rankings', () => {
        // 'shared' is rank 2 in each list → contribution 2/(k+2)
        // 'only-ft' and 'only-sem' only appear once at rank 1 → 1/(k+1)
        // 2/(60+2) ≈ 0.0323 beats 1/(60+1) ≈ 0.0164
        const ft = [hit('only-ft', 100), hit('shared', 1)];
        const sem = [hit('only-sem', 0.9), hit('shared', 0.05)];

        const fused = reciprocalRankFusion([ft, sem], {limit: 5});

        expect(fused[0]?.noteId).toBe('shared');
        expect(fused.slice(1).map((h) => h.noteId).sort()).toEqual(['only-ft', 'only-sem']);
    });

    it('is unaffected by score MAGNITUDE — only rank matters', () => {
        // huge fulltext scores vs tiny semantic scores: the result must still
        // promote a doc that shows up well in both.
        const ft = [hit('top-fulltext-spam', 10000), hit('shared', 50)];
        const sem = [hit('shared', 0.001), hit('semantic-only', 0.0001)];

        const fused = reciprocalRankFusion([ft, sem], {limit: 3});

        // 'shared' is rank 2 + rank 1 → 1/62 + 1/61 ≈ 0.0326
        // 'top-fulltext-spam' is rank 1 only → 1/61 ≈ 0.0164
        expect(fused[0]?.noteId).toBe('shared');
        expect(fused[1]?.noteId).toBe('top-fulltext-spam');
    });

    it('respects the limit', () => {
        const list = [hit('a', 1), hit('b', 1), hit('c', 1), hit('d', 1)];
        expect(reciprocalRankFusion([list], {limit: 2})).toHaveLength(2);
    });

    it('demote callback can downweight specific hits', () => {
        const ft = [hit('a', 1), hit('b', 1)];
        const sem = [hit('a', 1), hit('b', 1)];

        // demote 'a' to half its score → 'b' should win
        const fused = reciprocalRankFusion([ft, sem], {
            limit: 5,
            weightFor: (h) => h.noteId === 'a' ? 0.3 : 1
        });

        expect(fused[0]?.noteId).toBe('b');
        expect(fused[1]?.noteId).toBe('a');
    });

    it('prefers a snippet from whichever ranking carried one', () => {
        const ft = [hit('a', 1)]; // no snippet
        const sem = [hit('a', 1, 'semantic snippet')];

        const [merged] = reciprocalRankFusion([ft, sem], {limit: 1});
        expect(merged?.snippet).toBe('semantic snippet');
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
        // 0.4 (index) × 0.5 (heavy wikilinks) = 0.2
        expect(demote(hit('Crawler/foo/_index.md', 1))).toBeCloseTo(0.2, 5);
    });

    it('returns 1 for notes the lookup cannot find', () => {
        const demote = defaultDemote(() => undefined);
        expect(demote(hit('unknown.md', 1))).toBe(1);
    });
});