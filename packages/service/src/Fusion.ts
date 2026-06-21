import type {SearchHit, SearchHitComponents, SearchSignalName} from '@synaipse/core';

export interface FusionOptions {
    /** RRF dampening constant — 60 is the canonical value from the original paper. */
    k?: number;
    /** Per-hit multiplier applied after fusion. Use to demote noisy notes (e.g. crawler index files with hundreds of wikilinks). Should return a value in [0, 1]; 1 means no demotion. */
    weightFor?: (hit: SearchHit) => number;
    /** Max results returned. */
    limit: number;
}

export interface RankedSignal {
    name: SearchSignalName;
    hits: readonly SearchHit[];
}

interface Accumulator {
    hit: SearchHit;
    score: number;
    components: SearchHitComponents;
}

/**
 * Reciprocal Rank Fusion across multiple ranked lists. Each list contributes
 * 1 / (k + rank) per document. Score magnitude becomes irrelevant — only the
 * RELATIVE rank within each list matters — which fixes the classic problem of
 * mixing fulltext scores (0–200) with semantic similarity (0–1).
 *
 * Each output hit carries a `components` field with `{score, rank}` for every
 * signal that contributed plus an optional `demote` multiplier — lets the UI/
 * MCP explain *why* a hit ranked where it did.
 *
 * From "Reciprocal Rank Fusion outperforms Condorcet and individual Rank
 * Learning Methods" by Cormack, Clarke and Buettcher.
 */
export const reciprocalRankFusion = (
    signals: readonly RankedSignal[],
    opts: FusionOptions
): SearchHit[] => {
    const k = opts.k ?? 60;
    const map = new Map<string, Accumulator>();

    for (const signal of signals) {
        signal.hits.forEach((hit, idx) => {
            const rank = idx + 1;
            const contribution = 1 / (k + rank);
            const existing = map.get(hit.noteId);
            const component = {score: hit.score, rank};

            if (existing === undefined) {
                map.set(hit.noteId, {
                    hit: {...hit},
                    score: contribution,
                    components: {[signal.name]: component}
                });
                return;
            }

            existing.score += contribution;
            existing.components[signal.name] = component;

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
            const weight = weightFn(entry.hit);
            entry.score *= weight;

            if (weight < 1) {
                entry.components.demote = weight;
            }
        }
    }

    return [...map.values()]
        .sort((a, b) => b.score - a.score)
        .map((e) => ({...e.hit, score: e.score, components: e.components}))
        .slice(0, opts.limit);
};

/**
 * Wrap single-signal results so they share the same `components` shape as
 * fused hits. Lets the UI render breakdowns uniformly regardless of mode.
 */
export const annotateSingleSignal = (
    hits: readonly SearchHit[],
    name: SearchSignalName
): SearchHit[] =>
    hits.map((hit, idx) => ({
        ...hit,
        components: {[name]: {score: hit.score, rank: idx + 1}}
    }));

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
