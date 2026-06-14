import {describe, it, expect} from 'vitest';
import type {Note} from '@synaipse/core';
import {InvertedIndex, tokenise} from '../src/InvertedIndex.js';

const note = (id: string, title: string, content: string): Note => ({
    id,
    path: `/vault/${id}`,
    title,
    content,
    frontmatter: {},
    tags: [],
    wikilinks: [],
    backlinks: [],
    mtime: 0,
    hash: ''
});

describe('tokenise', () => {
    it('splits on whitespace and common separators', () => {
        expect(tokenise('foo bar-baz_qux/quux.zap')).toEqual(['foo', 'bar', 'baz', 'qux', 'quux', 'zap']);
    });

    it('lowercases', () => {
        expect(tokenise('Logger Conventions')).toEqual(['logger', 'conventions']);
    });

    it('drops stopwords and single-character tokens', () => {
        const tokens = tokenise('die katze und der hund a b 1 logger');
        expect(tokens).not.toContain('die');
        expect(tokens).not.toContain('und');
        expect(tokens).not.toContain('a');
        expect(tokens).toContain('katze');
        expect(tokens).toContain('logger');
    });
});

describe('InvertedIndex.build + size + termCount', () => {
    it('indexes notes and counts them', () => {
        const idx = new InvertedIndex();
        idx.build([
            note('a.md', 'Logger Conventions', 'winston-based logger pattern.'),
            note('b.md', 'Auth Callbacks', 'check user login, admin and activated.')
        ]);

        expect(idx.size()).toBe(2);
        expect(idx.termCount()).toBeGreaterThan(5);
    });
});

describe('InvertedIndex.search', () => {
    const make = (): InvertedIndex => {
        const idx = new InvertedIndex();
        idx.build([
            note('a.md', 'Logger Conventions', 'figtree winston logger pattern with levels and service boundary'),
            note('b.md', 'Auth Callbacks', 'check user login, admin and activated'),
            note('c.md', 'Random Thoughts', 'cats, recipes and other unrelated content'),
            note('d.md', 'Cluster Decision', 'logger needed for the cluster boundary')
        ]);
        return idx;
    };

    it('returns matches sorted by score', () => {
        const idx = make();
        const hits = idx.search('logger', 5);
        expect(hits.length).toBeGreaterThan(0);
        // a has body and title hit; d has body hit only
        expect(hits[0]?.noteId).toBe('a.md');
    });

    it('matches across multiple terms', () => {
        const idx = make();
        const hits = idx.search('logger boundary', 5);
        expect(hits.length).toBeGreaterThan(0);
        // a has both terms, d has both — but a also has title hit → higher
        expect(hits[0]?.noteId).toBe('a.md');
    });

    it('drops notes with zero hits', () => {
        const idx = make();
        const hits = idx.search('cats', 5);
        const ids = hits.map((h) => h.noteId);
        expect(ids).toContain('c.md');
        expect(ids).not.toContain('a.md');
        expect(ids).not.toContain('b.md');
    });

    it('returns [] for queries with only stopwords', () => {
        const idx = make();
        expect(idx.search('und der die', 5)).toEqual([]);
    });

    it('honours the limit', () => {
        const idx = make();
        expect(idx.search('a', 1).length).toBeLessThanOrEqual(1);
    });
});

describe('InvertedIndex.searchTitle', () => {
    it('only returns notes with title hits', () => {
        const idx = new InvertedIndex();
        idx.build([
            note('a.md', 'Cluster Decision', 'just body'),
            note('b.md', 'Random', 'cluster decision is mentioned in the body but not in the title')
        ]);

        const hits = idx.searchTitle('cluster', 5);
        expect(hits.length).toBe(1);
        expect(hits[0]?.noteId).toBe('a.md');
    });
});

describe('InvertedIndex.addNote + removeNote (incremental)', () => {
    it('add picks up a new note immediately', () => {
        const idx = new InvertedIndex();
        idx.build([]);
        expect(idx.search('cluster', 5)).toEqual([]);

        idx.addNote(note('c.md', 'Cluster', 'cluster works now'));
        expect(idx.search('cluster', 5).map((h) => h.noteId)).toEqual(['c.md']);
    });

    it('remove erases postings cleanly', () => {
        const idx = new InvertedIndex();
        idx.build([
            note('a.md', 'Cluster', 'cluster note'),
            note('b.md', 'Other', 'no match here')
        ]);

        idx.removeNote('a.md');
        expect(idx.search('cluster', 5)).toEqual([]);
        expect(idx.size()).toBe(1);
    });

    it('re-adding same id refreshes content', () => {
        const idx = new InvertedIndex();
        idx.build([note('a.md', 'V1', 'apples')]);
        expect(idx.search('apples', 5).length).toBe(1);
        expect(idx.search('pears', 5)).toEqual([]);

        idx.addNote(note('a.md', 'V2', 'pears'));
        expect(idx.search('apples', 5)).toEqual([]);
        expect(idx.search('pears', 5).map((h) => h.noteId)).toEqual(['a.md']);
    });
});