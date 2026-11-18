import {describe, expect, it} from 'vitest';
import type {Note, NoteId, SearchHit} from '@synaipse/core';
import {InvertedIndex} from '../src/InvertedIndex.js';
import {ReferenceInvertedIndex} from './ReferenceInvertedIndex.js';

/**
 * The compact index (plan P4 / A4) must rank exactly like the old
 * Map-based one: same hits, same order, bit-identical scores.
 */

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'graph', 'note', 'vault', 'qdrant', 'Übersicht', 'größe',
    'sehr-langes-kompositum-wort', 'ausgesprochenlangeswortohnetrenner', 'x', 'and', 'search', 'index',
    'memory', 'project', 'roadmap', 'link'];

const rng = (seed: number) => (): number => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const note = (id: string, title: string, content: string): Note =>
    ({id, path: id, title, content, frontmatter: {}, tags: [], wikilinks: [], backlinks: [], mtime: 0, hash: ''});

const randomNote = (r: () => number, id: string): Note => {
    const pick = (): string => WORDS[Math.floor(r() * WORDS.length)]!;
    const body = Array.from({length: 5 + Math.floor(r() * 80)}, pick).join(r() < 0.5 ? ' ' : ', ');
    return note(id, `${pick()} ${pick()}`, body);
};

const QUERIES = ['alpha', 'graph note', 'Übersicht größe', 'beta beta', 'sehr-langes-kompositum-wort search',
    'ausgesprochenlangeswortohnetrenner', 'nothing', 'and', 'x'];

const expectSame = (actual: SearchHit[], expected: SearchHit[]): void => {
    expect(actual.map((h) => [h.noteId, h.title, h.path, h.snippet]))
        .toEqual(expected.map((h) => [h.noteId, h.title, h.path, h.snippet]));
    actual.forEach((h, i) => expect(h.score).toBe(expected[i]!.score));
};

describe('compact InvertedIndex', () => {
    it('ranks exactly like the reference through build, edits and removals', () => {
        const r = rng(7);
        const notes = Array.from({length: 300}, (_, i) => randomNote(r, `n${i}.md`));
        const compact = new InvertedIndex();
        const reference = new ReferenceInvertedIndex();
        compact.build(notes);
        reference.build(notes);

        const check = (): void => {
            expect(compact.size()).toBe(reference.size());
            expect(compact.termCount()).toBe(reference.termCount());
            const accept = (id: NoteId): boolean => id.endsWith('3.md');
            for (const q of QUERIES) {
                expectSame(compact.search(q, 25), reference.search(q, 25));
                expectSame(compact.searchTitle(q, 25), reference.searchTitle(q, 25));
                expectSame(compact.search(q, 5, accept), reference.search(q, 5, accept));
            }
        };
        check();

        for (let round = 0; round < 400; round++) {
            const id = `n${Math.floor(r() * 360)}.md`;
            if (r() < 0.25) {
                compact.removeNote(id);
                reference.removeNote(id);
            } else {
                const next = randomNote(r, id);
                compact.addNote(next);
                reference.addNote(next);
            }
            if (round % 50 === 0) check();
        }
        check();
    });

    it('frees terms whose last note is gone and reuses the slots', () => {
        const index = new InvertedIndex();
        index.build([note('a', 'A', 'unique1 shared'), note('b', 'B', 'shared')]);
        const before = index.termCount();

        index.removeNote('a');
        expect(index.termCount()).toBe(before - 1);
        expect(index.search('unique1', 5)).toEqual([]);

        index.addNote(note('c', 'C', 'unique2 shared'));
        expect(index.termCount()).toBe(before);
        expect(index.search('unique2', 5).map((h) => h.noteId)).toEqual(['c']);
        expect(index.search('shared', 5).map((h) => h.noteId)).toEqual(['b', 'c']);
        expect(index.size()).toBe(2);
    });
});
