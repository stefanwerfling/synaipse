import type {Note, NoteId, SearchHit} from '@synaipse/core';

export interface AdjacencyMap {
    neighbors(id: NoteId): ReadonlySet<NoteId>;
    degree(id: NoteId): number;
    has(id: NoteId): boolean;
}

export interface GraphProximityOptions {
    /** Skip common neighbours whose degree exceeds this cap — keeps crawler-index hubs out of the AA sum. */
    heavyDegreeCap?: number;
    /** Bonus when a candidate IS one of the seeds. */
    seedSelfBonus?: number;
    /** Bonus when a candidate is a direct neighbour of a seed. */
    directLinkBonus?: number;
}

const DEFAULT_HEAVY_DEGREE_CAP = 30;
const DEFAULT_SEED_SELF_BONUS = 2.0;
const DEFAULT_DIRECT_LINK_BONUS = 1.0;

/**
 * Build an undirected adjacency map by unioning each note's outgoing wikilinks
 * (resolved to NoteIds via `resolveKey`) with the incoming backlinks already
 * present on the note. Result is symmetric: if A→B exists, both neighbour sets
 * contain the counterpart, regardless of whether the linker was indexed first.
 */
export const buildAdjacency = (
    notes: readonly Note[],
    resolveKey: (key: string) => NoteId | undefined
): AdjacencyMap => {
    const map = new Map<NoteId, Set<NoteId>>();

    const link = (a: NoteId, b: NoteId): void => {
        if (a === b) return;
        const setA = map.get(a) ?? new Set<NoteId>();
        setA.add(b);
        map.set(a, setA);
        const setB = map.get(b) ?? new Set<NoteId>();
        setB.add(a);
        map.set(b, setB);
    };

    for (const note of notes) {
        if (!map.has(note.id)) {
            map.set(note.id, new Set<NoteId>());
        }

        for (const key of note.wikilinks) {
            const target = resolveKey(key);
            if (target !== undefined) {
                link(note.id, target);
            }
        }

        for (const linker of note.backlinks) {
            link(note.id, linker);
        }
    }

    return {
        neighbors(id) {
            return map.get(id) ?? EMPTY_SET;
        },
        degree(id) {
            return map.get(id)?.size ?? 0;
        },
        has(id) {
            return map.has(id);
        }
    };
};

const EMPTY_SET: ReadonlySet<NoteId> = new Set();

/**
 * Per-candidate proximity score against the seed set. Combines three signals:
 *
 *   1. Self-bonus  — candidate IS a seed
 *   2. Direct link — candidate is a 1-hop neighbour of a seed
 *   3. Adamic-Adar — candidates and seeds sharing common neighbours; each
 *                    common neighbour contributes 1 / log(degree + e). Heavy
 *                    hubs (crawler indices) are skipped so they can't dominate.
 *
 * Bounded to 2 hops by construction (direct + common-neighbour reach).
 */
export const graphProximityScore = (
    candidate: NoteId,
    seeds: readonly NoteId[],
    adj: AdjacencyMap,
    opts: GraphProximityOptions = {}
): number => {
    if (seeds.length === 0) return 0;

    const heavyCap = opts.heavyDegreeCap ?? DEFAULT_HEAVY_DEGREE_CAP;
    const selfBonus = opts.seedSelfBonus ?? DEFAULT_SEED_SELF_BONUS;
    const directBonus = opts.directLinkBonus ?? DEFAULT_DIRECT_LINK_BONUS;

    const candidateNeighbors = adj.neighbors(candidate);
    let score = 0;

    for (const seed of seeds) {
        if (seed === candidate) {
            score += selfBonus;
            continue;
        }

        const seedNeighbors = adj.neighbors(seed);

        if (seedNeighbors.has(candidate)) {
            score += directBonus;
        }

        const [smaller, larger] = candidateNeighbors.size <= seedNeighbors.size
            ? [candidateNeighbors, seedNeighbors]
            : [seedNeighbors, candidateNeighbors];

        for (const common of smaller) {
            if (!larger.has(common)) continue;
            const degree = adj.degree(common);
            if (degree > heavyCap) continue;
            // log(degree + e) — adds Euler's e so deg=1 still contributes 1/1
            score += 1 / Math.log(degree + Math.E);
        }
    }

    return score;
};

/**
 * Rank a list of candidate hits by graph proximity to the seed set, returning
 * a fresh SearchHit list ordered by descending proximity. Candidates with zero
 * proximity are dropped — they have no graph signal to contribute. The result
 * is consumable by reciprocalRankFusion as a `RankedSignal`.
 */
export const rankByGraphProximity = (
    candidates: readonly SearchHit[],
    seeds: readonly NoteId[],
    adj: AdjacencyMap,
    opts: GraphProximityOptions = {}
): SearchHit[] => {
    if (seeds.length === 0 || candidates.length === 0) return [];

    const seen = new Set<NoteId>();
    const scored: {hit: SearchHit; score: number}[] = [];

    for (const hit of candidates) {
        if (seen.has(hit.noteId)) continue;
        seen.add(hit.noteId);

        const score = graphProximityScore(hit.noteId, seeds, adj, opts);
        if (score <= 0) continue;
        scored.push({hit, score});
    }

    return scored
        .sort((a, b) => b.score - a.score)
        .map(({hit, score}) => ({...hit, score}));
};