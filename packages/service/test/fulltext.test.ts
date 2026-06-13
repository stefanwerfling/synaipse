import {describe, it, expect} from 'vitest';
import {fulltextSearch} from '../src/Fulltext.js';
import type {Note} from '@synaipse/core';

const note = (id: string, title: string, content: string): Note => ({
    id, path: `/v/${id}`, title, content,
    frontmatter: {}, tags: [], wikilinks: [], backlinks: [], mtime: 0, hash: ''
});

describe('fulltextSearch', () => {
    const notes = [
        note('a.md', 'Cluster decision', 'we decided to introduce BackendCluster'),
        note('b.md', 'Embedding setup', 'voyage embeddings for semantic search'),
        note('c.md', 'Random', 'unrelated content about cats')
    ];

    it('returns hits sorted by relevance', () => {
        const hits = fulltextSearch(notes, 'cluster', 10);
        expect(hits[0]?.noteId).toBe('a.md');
    });

    it('returns empty for empty query', () => {
        expect(fulltextSearch(notes, '   ', 10)).toEqual([]);
    });

    it('respects limit', () => {
        const hits = fulltextSearch(notes, 'a', 1);
        expect(hits.length).toBeLessThanOrEqual(1);
    });

    it('boosts title matches', () => {
        const hits = fulltextSearch(notes, 'embedding', 10);
        expect(hits[0]?.noteId).toBe('b.md');
    });
});