import {describe, expect, it} from 'vitest';
import type {SearchHit} from '@synaipse/core';
import {DUPLICATE_THRESHOLD, MAX_DUPLICATES, duplicateQuery, pickDuplicates, similarity, wordsOf} from '../src/Duplicates.js';

const hit = (id: string, semantic?: number): SearchHit => ({
    noteId: id, path: id, title: id, score: 1,
    ...(semantic !== undefined ? {components: {semantic: {score: semantic, rank: 1}}} : {})
});

describe('wordsOf', () => {
    it('keeps words of 3+ letters or digits, lower-cased, without stopwords and markup', () => {
        expect([...wordsOf('The [[Rate Limit]] is 600/min für die API, ok?')].sort()).toEqual(['600', 'api', 'limit', 'min', 'rate']);
    });
});

describe('similarity', () => {
    it('is high for the same knowledge in other words order and low for a related topic', () => {
        const existing = {title: 'API rate limits', content: 'The public API allows 600 requests per minute per API key; bursts of 100 via a token bucket; 429 with Retry-After.'};

        expect(similarity({title: 'Public API rate limit', content: 'Each API key may send 600 requests per minute, token bucket bursts of 100, then 429 with Retry-After.'}, existing))
            .toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
        expect(similarity({title: 'API key scopes', content: 'Public API keys carry scopes; a request outside its scopes gets 403.'}, existing))
            .toBeLessThan(DUPLICATE_THRESHOLD);
    });

    it('counts a short insight the note already contains', () => {
        const note = {title: 'Postgres connection limits', content: 'Production Postgres has max_connections = 400. PgBouncer in transaction mode with a pool of 40 per node; the worker has its own pool.'};

        expect(similarity({title: '', content: 'Postgres max_connections is 400 in production.'}, note)).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
    });

    it('is 0 for empty text', () => {
        expect(similarity({title: '', content: 'a b'}, {title: 'x', content: 'y'})).toBe(0);
    });
});

describe('pickDuplicates', () => {
    const notes: Record<string, {title: string; content: string}> = {
        'same.md': {title: 'Cache in Redis', content: 'The cache lives in Redis with a 24 hour TTL and LRU eviction.'},
        'other.md': {title: 'Deploy pipeline', content: 'Images are built in CI and deployed on Tuesdays.'},
        'semantic.md': {title: 'Caching layer', content: 'Completely different wording.'}
    };
    const lookup = (id: string) => notes[id];
    const fresh = {title: 'Redis cache', content: 'Our cache lives in Redis, 24 hour TTL, LRU eviction.'};

    it('keeps similar notes, drops the excluded one, unknown ids and dissimilar notes', () => {
        const out = pickDuplicates(fresh, [hit('same.md'), hit('same.md'), hit('other.md'), hit('gone.md'), hit('self.md')], lookup, new Set(['self.md']));

        expect(out.map((d) => d.id)).toEqual(['same.md']);
        expect(out[0]!.similarity).toBeGreaterThan(0.5);
    });

    it('trusts a very close semantic hit even with other words', () => {
        expect(pickDuplicates(fresh, [hit('semantic.md', 0.93)], lookup).map((d) => d.id)).toEqual(['semantic.md']);
        expect(pickDuplicates(fresh, [hit('semantic.md', 0.8)], lookup)).toEqual([]);
    });

    it('returns at most MAX_DUPLICATES, most similar first', () => {
        const many = Object.fromEntries(Array.from({length: 6}, (_, i) => [`n${i}.md`, {title: 'Redis cache', content: `The cache lives in Redis with a 24 hour TTL${' and LRU eviction'.repeat(i % 2)}.`}]));
        const out = pickDuplicates(fresh, Object.keys(many).map((id) => hit(id)), (id) => many[id]);

        expect(out).toHaveLength(MAX_DUPLICATES);
        expect(out[0]!.similarity).toBeGreaterThanOrEqual(out[2]!.similarity);
    });

    it('builds the candidate query from title and the start of the body', () => {
        expect(duplicateQuery({title: 'T', content: 'a\n\nb'})).toBe('T a b');
        expect(duplicateQuery({title: '', content: 'x'.repeat(400)})).toHaveLength(300);
    });
});
