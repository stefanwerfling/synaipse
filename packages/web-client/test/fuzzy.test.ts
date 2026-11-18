import {describe, it, expect} from 'vitest';
import {fuzzyMatch, searchNotes, type NoteCandidate} from '../src/Fuzzy.js';

describe('fuzzyMatch', () => {
    it('matches an exact subsequence', () => {
        const r = fuzzyMatch('abc', 'aXbXcX');
        expect(r.matched).toBe(true);
        expect(r.indices).toEqual([0, 2, 4]);
    });

    it('does not match when a char is missing in order', () => {
        const r = fuzzyMatch('abc', 'a');
        expect(r.matched).toBe(false);
    });

    it('returns matched=true with score 0 for empty query', () => {
        const r = fuzzyMatch('', 'anything');
        expect(r.matched).toBe(true);
        expect(r.score).toBe(0);
    });

    it('case-insensitive base match, case-sensitive bonus', () => {
        const insensitive = fuzzyMatch('abc', 'ABCdef');
        const sensitive = fuzzyMatch('abc', 'abcdef');
        expect(insensitive.matched).toBe(true);
        expect(sensitive.matched).toBe(true);
        expect(sensitive.score).toBeGreaterThan(insensitive.score);
    });

    it('prefers word-boundary matches', () => {
        // 'd' as start of 'db' (word boundary) should outscore 'd' inside another word
        const boundary = fuzzyMatch('db', 'project/db-schema.md');
        const middle = fuzzyMatch('db', 'projectdbthings.md');
        expect(boundary.matched).toBe(true);
        expect(middle.matched).toBe(true);
        expect(boundary.score).toBeGreaterThan(middle.score);
    });

    it('rewards contiguous runs over scattered matches without word boundaries', () => {
        // both start at 0 — but loose has gaps inside non-separator chars so gets penalised
        const tight = fuzzyMatch('logger', 'loggerStuff');
        const loose = fuzzyMatch('logger', 'lxoxgxgxexrx');
        expect(tight.matched).toBe(true);
        expect(loose.matched).toBe(true);
        expect(tight.score).toBeGreaterThan(loose.score);
    });
});

describe('searchNotes', () => {
    const notes: NoteCandidate[] = [
        {id: 'Memory/swipemeister/standards/auth-callbacks.md', title: 'Auth Callbacks — CheckUserLogin / CheckUserIsAdmin / CheckUserIsActivated'},
        {id: 'Memory/swipemeister/standards/logger-conventions.md', title: 'Logger Conventions — figtree/winston, Levels, Service Boundary'},
        {id: 'Memory/swipemeister/decisions/vote-ranking.md', title: 'Vote Ranking Decision'},
        {id: 'Memory/figtree/acl_config_logger.md', title: 'FigTree — ACL, Config, Logger'},
        {id: 'Memory/random/foo.md', title: 'Random Stuff', aliases: ['shortcut']},
        {id: 'Crawler/devto/x.md', title: 'unrelated devto article', tags: ['mcp', 'protocol']}
    ];

    it('returns all notes (in input order, limited) for empty query', () => {
        const result = searchNotes('', notes, 3);
        expect(result.length).toBe(3);
        expect(result[0]?.note.title).toBe(notes[0]?.title);
    });

    it('ranks an exact title prefix highest', () => {
        const result = searchNotes('logger conventions', notes, 5);
        expect(result[0]?.note.title).toMatch(/^Logger Conventions/);
    });

    it('finds via alias when title does not match', () => {
        const [first] = searchNotes('shortcut', notes, 5);
        expect(first?.note.title).toBe('Random Stuff');
        expect(first?.via).toBe('alias');
    });

    it('finds via tag when title and id do not match (lower priority)', () => {
        const result = searchNotes('mcp', notes, 5);
        const tagHit = result.find((r) => r.note.title.includes('unrelated devto'));
        expect(tagHit).toBeDefined();
        expect(tagHit?.via).toBe('tag');
    });

    it('drops unmatched notes', () => {
        const result = searchNotes('logger', notes, 10);
        expect(result.every((r) => r.score > 0)).toBe(true);
        expect(result.some((r) => r.note.id.includes('vote-ranking'))).toBe(false);
    });

    it('matches by path segments not just title', () => {
        const result = searchNotes('vote-ranking', notes, 5);
        expect(result[0]?.note.id).toContain('vote-ranking');
    });

    it('limits results', () => {
        expect(searchNotes('m', notes, 2).length).toBeLessThanOrEqual(2);
    });
});