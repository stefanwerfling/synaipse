import {describe, it, expect} from 'vitest';
import {chunkNote} from '../src/Chunker.js';
import type {Note} from '@synaipse/core';

const note = (content: string): Note => ({
    id: 'n.md',
    path: '/v/n.md',
    title: 'n',
    content,
    frontmatter: {},
    tags: [],
    wikilinks: [],
    backlinks: [],
    mtime: 0,
    hash: ''
});

describe('chunkNote', () => {
    it('returns empty for empty content', () => {
        expect(chunkNote(note(''))).toEqual([]);
    });

    it('packs paragraphs up to target size', () => {
        const para = 'word '.repeat(40).trim();
        const chunks = chunkNote(note([para, para, para, para].join('\n\n')), {
            targetChars: 500,
            overlapChars: 50
        });

        expect(chunks.length).toBeGreaterThan(0);
        for (const chunk of chunks) {
            expect(chunk.noteId).toBe('n.md');
            expect(chunk.text.length).toBeGreaterThan(0);
        }
    });

    it('assigns monotonic indices and stable ids', () => {
        const big = ('a '.repeat(200) + '\n\n').repeat(5);
        const chunks = chunkNote(note(big), {targetChars: 300, overlapChars: 30});

        expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
        expect(chunks[0]!.id).toBe('n.md::0');
    });
});