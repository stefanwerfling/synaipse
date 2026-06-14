import type {SearchHit} from '@synaipse/core';

export interface FusionOptions {
    /** RRF dampening constant — 60 is the canonical value from the original paper. */
    k?: number;
    /** Per-hit multiplier applied after fusion. Use to demote noisy notes (e.g. crawler index files with hundreds of wikilinks). Should return a value in [0, 1]; 1 means no demotion. */
    weightFor?: (hit: SearchHit) => number;
    /** Max results returned. */
    limit: number;
}

interface Accumulator {
    hit: SearchHit;
    score: number;
}

/**
 * Reciprocal Rank Fusion across multiple ranked lists. Each list contributes
 * 1 / (k + rank) per document. Score magnitude becomes irrelevant — only the
 * RELATIVE rank within each list matters — which fixes the classic problem of
 * mixing fulltext scores (0–200) with semantic similarity (0–1).
 *
 * From "Reciprocal Rank Fusion outperforms Condorcet and individual Rank
 * Learning Methods" by Cormack, Clarke and Buettcher.
 */
export const reciprocalRankFusion = (
    rankings: readonly (readonly SearchHit[])[],
    opts: FusionOptions
): SearchHit[] => {
    const k = opts.k ?? 60;
    const map = new Map<string, Accumulator>();

    for (const ranked of rankings) {
        ranked.forEach((hit, idx) => {
            const rank = idx + 1;
            const contribution = 1 / (k + rank);
            const existing = map.get(hit.noteId);

            if (existing === undefined) {
                map.set(hit.noteId, {hit: {...hit}, score: contribution});
                return;
            }

            existing.score += contribution;

            // Prefer the snippet from whichever ranking placed it higher
            // — usually semantic snippets are better for RAG context.
            if (existing.hit.snippet === undefined && hit.snippet !== undefined) {
                existing.hit.snippet = hit.snippet;
            }
        });
    }

    if (opts.weightFor !== undefined) {
        const weightFn = opts.weightFor;

        for (const entry of map.values()) {
            entry.score *= weightFn(entry.hit);
        }
    }

    return [...map.values()]
        .sort((a, b) => b.score - a.score)
        .map((e) => ({...e.hit, score: e.score}))
        .slice(0, opts.limit);
};

const INDEX_FILE_RE = /\/_index\.md$/i;
const HEAVY_WIKILINK_THRESHOLD = 30;

/**
 * Default demote function for Synaipse hybrid search. Reduces the influence
 * of crawler index files and any note crammed with many wikilinks — they win
 * fulltext by sheer surface area, not relevance.
 */
export const defaultDemote = (lookup: (noteId: string) => {wikilinks: readonly string[]} | undefined) => {
    return (hit: SearchHit): number => {
        let weight = 1;

        if (INDEX_FILE_RE.test(hit.noteId)) {
            weight *= 0.4;
        }

        const note = lookup(hit.noteId);

        if (note !== undefined && note.wikilinks.length > HEAVY_WIKILINK_THRESHOLD) {
            weight *= 0.5;
        }

        return weight;
    };
};