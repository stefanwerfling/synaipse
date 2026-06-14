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

const STOPWORDS = new Set([
    'und', 'oder', 'die', 'der', 'das', 'ein', 'eine', 'wie', 'was', 'wo', 'wer',
    'sind', 'ist', 'sein', 'haben', 'habe', 'hat', 'mit', 'von', 'für', 'auf',
    'an', 'in', 'im', 'aus', 'zu', 'zur', 'zum',
    'the', 'and', 'or', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'for'
]);

const queryTerms = (query: string): string[] => {
    return query
        .toLowerCase()
        .split(/[\s\-_/]+/)
        .filter((t) => t.length > 1 && !STOPWORDS.has(t))
        .map(escape);
};

export const fulltextSearch = (notes: Iterable<Note>, query: string, limit: number): SearchHit[] => {
    const terms = queryTerms(query);

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

/**
 * Separate ranking that scores TITLE matches only. Used as an additional RRF
 * input so a note whose title hits the query terms ranks well even if longer
 * notes accumulate more body matches by sheer surface area.
 */
export const titleSearch = (notes: Iterable<Note>, query: string, limit: number): SearchHit[] => {
    const terms = queryTerms(query);

    if (terms.length === 0) {
        return [];
    }

    const hits: SearchHit[] = [];

    for (const note of notes) {
        const lowerTitle = note.title.toLowerCase();
        let titleHits = 0;

        for (const term of terms) {
            if (lowerTitle.includes(term)) {
                titleHits += 1;
            }
        }

        if (titleHits === 0) {
            continue;
        }

        hits.push({
            noteId: note.id,
            path: note.path,
            title: note.title,
            score: titleHits,
            snippet: note.content.slice(0, 200)
        });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
};