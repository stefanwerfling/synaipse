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

describe('InvertedIndex.search — BM25 length normalization', () => {
    it('short focused note outranks long off-topic note that mentions the term more often', () => {
        const idx = new InvertedIndex();
        const longBody = ('lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(100))
            + ' qdrant qdrant qdrant qdrant qdrant qdrant qdrant qdrant qdrant qdrant';
        const shortBody = 'qdrant client setup and collection configuration. qdrant runs in docker. qdrant qdrant qdrant';
        idx.build([
            note('long.md', 'Long Off Topic', longBody),
            note('short.md', 'Short Focused', shortBody),
            note('decoy.md', 'Decoy', 'unrelated body about other topics')
        ]);

        const hits = idx.search('qdrant', 5);
        expect(hits[0]?.noteId).toBe('short.md');
        const longIdx = hits.findIndex((h) => h.noteId === 'long.md');
        const shortIdx = hits.findIndex((h) => h.noteId === 'short.md');
        expect(shortIdx).toBeLessThan(longIdx);
    });

    it('IDF favours rare terms — a common term distributes weight thinly', () => {
        const idx = new InvertedIndex();
        idx.build([
            note('a.md', 'A', 'docker setup'),
            note('b.md', 'B', 'docker compose'),
            note('c.md', 'C', 'docker swarm'),
            note('d.md', 'D', 'docker secret'),
            note('e.md', 'E', 'docker qdrant'),
            note('f.md', 'F', 'qdrant store')
        ]);

        // "qdrant" appears in 2/6 docs, "docker" in 5/6 — rare term must dominate.
        const hits = idx.search('docker qdrant', 6);
        const qdrantNotes = new Set(['e.md', 'f.md']);
        expect(qdrantNotes.has(hits[0]?.noteId ?? '')).toBe(true);
        expect(qdrantNotes.has(hits[1]?.noteId ?? '')).toBe(true);
    });

    it('TF saturation — repeating a term 10× is not 10× the score of mentioning it once', () => {
        const idx = new InvertedIndex();
        const body1 = 'qdrant ' + 'filler '.repeat(40);
        const body10 = 'qdrant '.repeat(10) + 'filler '.repeat(31);
        idx.build([
            note('one.md', 'One', body1),
            note('ten.md', 'Ten', body10)
        ]);

        const oneHit = idx.search('qdrant', 5).find((h) => h.noteId === 'one.md');
        const tenHit = idx.search('qdrant', 5).find((h) => h.noteId === 'ten.md');
        expect(oneHit).toBeDefined();
        expect(tenHit).toBeDefined();
        const ratio = (tenHit?.score ?? 0) / (oneHit?.score ?? 1);
        expect(ratio).toBeGreaterThan(1);
        expect(ratio).toBeLessThan(5);
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