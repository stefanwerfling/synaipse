import type {Note, SearchHit} from '@synaipse/core';

const escape = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const scoreNote = (note: Note, terms: string[]): {score: number; snippet: string} => {
    const haystack = `${note.title}\n${note.content}`.toLowerCase();
    let score = 0;
    let snippet = '';

    for (const term of terms) {
        const matches = haystack.split(term).length - 1;
        score += matches * (term.length >= 4 ? 2 : 1);

        if (!snippet && matches > 0) {
            const idx = haystack.indexOf(term);
            const start = Math.max(0, idx - 60);
            const end = Math.min(haystack.length, idx + term.length + 120);
            snippet = `${haystack.slice(start, end)}`;
        }
    }

    if (terms.some((t) => note.title.toLowerCase().includes(t))) {
        score += 5;
    }

    return {score, snippet};
};

export const fulltextSearch = (notes: Iterable<Note>, query: string, limit: number): SearchHit[] => {
    const terms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0)
        .map(escape);

    if (terms.length === 0) {
        return [];
    }

    const hits: SearchHit[] = [];

    for (const note of notes) {
        const {score, snippet} = scoreNote(note, terms);

        if (score === 0) {
            continue;
        }

        hits.push({
            noteId: note.id,
            path: note.path,
            title: note.title,
            score,
            snippet: snippet || note.content.slice(0, 200)
        });
    }

    hits.sort((a, b) => b.score - a.score);

    return hits.slice(0, limit);
};