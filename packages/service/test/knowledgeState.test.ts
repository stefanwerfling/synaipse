import {describe, expect, it} from 'vitest';
import type {SearchHit} from '@synaipse/core';
import {
    EXPIRED_WEIGHT, SUPERSEDED_WEIGHT, applyKnowledgeState, buildSuccessors, knowledgeStateOf, supersededTargets, type KnowledgeNote
} from '../src/KnowledgeState.js';

const NOW = Date.parse('2025-12-01T00:00:00Z');
const note = (id: string, fm: Record<string, unknown> = {}, mtime = 0): KnowledgeNote => ({id, title: id.replace(/\.md$/, ''), mtime, frontmatter: fm});
const hit = (id: string, score: number): SearchHit => ({noteId: id, path: id, title: id, score});

describe('supersededTargets', () => {
    it('reads the supersedes field and typed links, without wikilink brackets', () => {
        expect(supersededTargets({
            supersedes: ['[[Old A|alias]]', 'Old B', 3],
            links: [{target: 'Old C', kind: 'supersedes'}, {target: 'Other', kind: 'relates_to'}]
        })).toEqual(['Old A', 'Old B', 'Old C']);
        expect(supersededTargets({})).toEqual([]);
    });
});

describe('buildSuccessors', () => {
    const resolve = (t: string): string | undefined => (['a.md', 'b.md', 'c.md', 'x.md'].includes(`${t}.md`) ? `${t}.md` : undefined);

    it('follows chains to the newest note and ignores unknown targets and self references', () => {
        const map = buildSuccessors([
            note('b.md', {supersedes: ['a', 'nope', 'b']}),
            note('c.md', {supersedes: ['b']})
        ], resolve);

        expect(map.get('a.md')).toBe('c.md');
        expect(map.get('b.md')).toBe('c.md');
        expect(map.has('c.md')).toBe(false);
    });

    it('lets the newer of two successors win; notes in a cycle count as not superseded', () => {
        expect(buildSuccessors([note('b.md', {supersedes: ['a']}, 1), note('c.md', {supersedes: ['a']}, 2)], resolve).get('a.md')).toBe('c.md');

        const cyclic = buildSuccessors([note('a.md', {supersedes: ['b']}), note('b.md', {supersedes: ['a']})], resolve);
        expect(cyclic.size).toBe(0);
    });
});

describe('knowledgeStateOf', () => {
    const successors = new Map([['old.md', 'new.md']]);

    it('combines superseded, expired and confidence', () => {
        expect(knowledgeStateOf(note('x.md'), successors, NOW)).toEqual({weight: 1});
        expect(knowledgeStateOf(note('old.md'), successors, NOW)).toEqual({weight: SUPERSEDED_WEIGHT, supersededBy: 'new.md'});
        expect(knowledgeStateOf(note('x.md', {valid_until: '2025-11-30'}), successors, NOW)).toEqual({weight: EXPIRED_WEIGHT, expired: true});
        expect(knowledgeStateOf(note('x.md', {confidence: 0.4}), successors, NOW)).toEqual({weight: 0.7, confidence: 0.4});
    });

    it('treats valid_until as the whole day, accepts YAML dates and ignores garbage', () => {
        expect(knowledgeStateOf(note('x.md', {valid_until: '2025-12-01'}), successors, NOW).expired).toBeUndefined();
        expect(knowledgeStateOf(note('x.md', {valid_until: new Date('2025-11-30')}), successors, NOW).expired).toBe(true);
        expect(knowledgeStateOf(note('x.md', {valid_until: 'soon', confidence: 1}), successors, NOW)).toEqual({weight: 1});
    });
});

describe('applyKnowledgeState', () => {
    const notes = new Map([
        ['old.md', note('old.md')],
        ['new.md', note('new.md')],
        ['other.md', note('other.md')],
        ['guess.md', note('guess.md', {confidence: 0.2})]
    ]);
    const lookup = (id: string): KnowledgeNote | undefined => notes.get(id);
    const successors = new Map([['old.md', 'new.md']]);

    it('puts the successor where the superseded note was and marks the old hit', () => {
        const out = applyKnowledgeState([hit('old.md', 1), hit('other.md', 0.8)], 5, lookup, successors, NOW);

        expect(out.map((h) => h.noteId)).toEqual(['new.md', 'other.md', 'old.md']);
        expect(out[0]!.score).toBe(1);
        expect(out[2]).toMatchObject({supersededBy: 'new.md', score: SUPERSEDED_WEIGHT});
    });

    it('raises a successor that was already a lower hit instead of duplicating it', () => {
        const out = applyKnowledgeState([hit('old.md', 1), hit('other.md', 0.8), hit('new.md', 0.1)], 5, lookup, successors, NOW);

        expect(out.map((h) => h.noteId)).toEqual(['new.md', 'other.md', 'old.md']);
    });

    it('demotes low confidence and cuts to the limit', () => {
        const out = applyKnowledgeState([hit('guess.md', 1), hit('other.md', 0.7)], 1, lookup, new Map(), NOW);

        expect(out).toEqual([hit('other.md', 0.7)]);
    });

    it('leaves the order alone when nothing is outdated', () => {
        const hits = [hit('other.md', 0.5), hit('new.md', 0.5)];
        expect(applyKnowledgeState(hits, 5, lookup, successors, NOW)).toEqual(hits);
    });
});
