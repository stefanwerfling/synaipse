export interface FuzzyResult {
    matched: boolean;
    score: number;
    /** Indices in the target that were matched, in order. Length 0 when matched=false. */
    indices: number[];
}

/**
 * Subsequence fuzzy match scoring inspired by VS Code's command palette and
 * fzf. Returns matched=false when query is not a subsequence of target.
 *
 * Score components:
 * - +5  per word-boundary match (first char of word)
 * - +3  per camel-case boundary
 * - +2  per case-sensitive exact match
 * - +1  per contiguous-run extension
 * - -1  per skipped char (gap penalty)
 * - bonus = (target.length - lastMatchIndex)  → prefer matches near the front
 */
export const fuzzyMatch = (query: string, target: string): FuzzyResult => {
    if (query.length === 0) {
        return {matched: true, score: 0, indices: []};
    }

    const tLower = target.toLowerCase();
    const qLower = query.toLowerCase();

    const indices: number[] = [];
    let score = 0;
    let lastMatch = -1;

    let qi = 0;

    for (let ti = 0; ti < tLower.length && qi < qLower.length; ti += 1) {
        if (tLower[ti] !== qLower[qi]) continue;

        // gap penalty
        if (lastMatch >= 0) {
            score -= ti - lastMatch - 1;
        }

        // word-boundary bonus
        if (ti === 0) {
            score += 5;
        } else {
            const prev = target[ti - 1];

            if (prev !== undefined && /[\s/_\-.]/.test(prev)) {
                score += 5;
            } else if (prev !== undefined && prev === prev.toLowerCase() && target[ti] !== target[ti]!.toLowerCase()) {
                score += 3; // camelCase boundary
            }
        }

        // contiguous-run bonus
        if (lastMatch >= 0 && ti === lastMatch + 1) {
            score += 1;
        }

        // exact-case bonus
        if (target[ti] === query[qi]) {
            score += 2;
        }

        indices.push(ti);
        lastMatch = ti;
        qi += 1;
    }

    if (qi < qLower.length) {
        return {matched: false, score: 0, indices: []};
    }

    // prefer matches near the front
    if (indices.length > 0 && indices[0]! < 8) {
        score += 8 - indices[0]!;
    }

    return {matched: true, score, indices};
};

export interface NoteCandidate {
    id: string;
    title: string;
    aliases?: readonly string[];
    tags?: readonly string[];
}

export interface NoteRanked<T extends NoteCandidate = NoteCandidate> {
    note: T;
    score: number;
    /** Which field carried the best match. */
    via: 'title' | 'alias' | 'id' | 'tag';
    /** Indices in the matched field; useful for highlighting. */
    indices: number[];
    /** The matched field value (helpful for rendering). */
    matchedText: string;
}

export const searchNotes = <T extends NoteCandidate>(
    query: string,
    notes: readonly T[],
    limit = 20
): NoteRanked<T>[] => {
    const trimmed = query.trim();

    if (trimmed.length === 0) {
        return notes.slice(0, limit).map((n) => ({
            note: n,
            score: 0,
            via: 'title' as const,
            indices: [],
            matchedText: n.title
        }));
    }

    const ranked: NoteRanked<T>[] = [];

    for (const note of notes) {
        let best: {score: number; via: NoteRanked['via']; indices: number[]; text: string} | null = null;

        const tryField = (text: string, via: NoteRanked['via'], bias: number): void => {
            const m = fuzzyMatch(trimmed, text);

            if (!m.matched) return;

            const adjusted = m.score + bias;

            if (best === null || adjusted > best.score) {
                best = {score: adjusted, via, indices: m.indices, text};
            }
        };

        tryField(note.title, 'title', 10);
        tryField(note.id, 'id', 0);

        for (const alias of note.aliases ?? []) {
            tryField(alias, 'alias', 5);
        }

        for (const tag of note.tags ?? []) {
            tryField(tag, 'tag', -2);
        }

        if (best !== null) {
            const b = best as {score: number; via: NoteRanked['via']; indices: number[]; text: string};
            ranked.push({
                note,
                score: b.score,
                via: b.via,
                indices: b.indices,
                matchedText: b.text
            });
        }
    }

    return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
};