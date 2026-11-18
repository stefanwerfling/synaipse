import type {NoteId, SearchHit} from '@synaipse/core';

/**
 * Near-duplicate check for writes (plan P8 / B4): before an agent creates
 * a note or appends to the inbox, candidates from search are compared
 * with the new text. Search scores are not comparable across queries, so
 * the decision uses word overlap (and, when present, the semantic
 * similarity of the hit): a stable 0..1 number with one threshold.
 */

export interface DuplicateCandidate {
    id: NoteId;
    title: string;
    /** 0..1, two decimals. */
    similarity: number;
}

export interface DuplicateText {
    title: string;
    content: string;
}

/**
 * From this similarity on a candidate is reported. Calibrated on the eval
 * drafts (P8 S3): new knowledge with shared vocabulary scored up to
 * 0.30–0.35, rewritten duplicates from about 0.5 on; 0.42 sits between.
 */
export const DUPLICATE_THRESHOLD = 0.42;
/** Semantic hits count from this cosine on (embeddings only). */
const SEMANTIC_DUPLICATE = 0.88;
export const MAX_DUPLICATES = 3;

const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'were', 'from', 'not', 'but', 'have', 'has', 'had', 'its', 'into',
    'than', 'then', 'they', 'them', 'their', 'there', 'when', 'what', 'which', 'who', 'will', 'can', 'all', 'any', 'one', 'our',
    'you', 'your', 'via', 'per', 'after', 'before', 'about', 'now', 'also', 'only', 'more', 'most', 'some', 'such', 'each',
    'der', 'die', 'das', 'und', 'mit', 'für', 'von', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'ist', 'sind', 'nicht', 'auf',
    'auch', 'als', 'bei', 'nach', 'wie', 'wird', 'werden', 'oder', 'aus', 'zum', 'zur', 'noch', 'nur', 'sich'
]);

/** Lower-cased words of 3+ letters/digits, without stopwords, wikilink and markdown noise. */
export const wordsOf = (text: string): Set<string> => {
    const out = new Set<string>();

    for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (raw.length >= 3 && !STOPWORDS.has(raw)) out.add(raw);
    }

    return out;
};

const overlap = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
    let n = 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const w of small) if (large.has(w)) n++;
    return n;
};

/**
 * 0..1: the larger of Jaccard (same note twice) and 0.8 × containment of
 * the new text in the candidate (a short insight the note already says).
 * Titles alone count when they share almost all words (two or more).
 */
export const similarity = (fresh: DuplicateText, existing: DuplicateText): number => {
    const a = wordsOf(`${fresh.title} ${fresh.content}`);
    const b = wordsOf(`${existing.title} ${existing.content}`);
    if (a.size === 0 || b.size === 0) return 0;

    const shared = overlap(a, b);
    const jaccard = shared / (a.size + b.size - shared);
    const containment = shared / a.size;

    const ta = wordsOf(fresh.title);
    const tb = wordsOf(existing.title);
    const titleShared = overlap(ta, tb);
    const titleSim = ta.size >= 2 && tb.size >= 2 ? titleShared / (ta.size + tb.size - titleShared) : 0;

    return Math.max(jaccard, 0.8 * containment, titleSim >= 0.75 ? titleSim * 0.8 : 0);
};

/** The search query for candidates: title plus the start of the body. */
export const duplicateQuery = (text: DuplicateText): string => `${text.title} ${text.content.replace(/\s+/g, ' ').slice(0, 300)}`.trim();

/**
 * Rank search candidates by similarity to the new text and keep those at
 * or above DUPLICATE_THRESHOLD (at most MAX_DUPLICATES). `exclude` drops
 * the note being written itself.
 */
export const pickDuplicates = (
    fresh: DuplicateText,
    hits: readonly SearchHit[],
    lookup: (id: NoteId) => DuplicateText | undefined,
    exclude: ReadonlySet<NoteId> = new Set()
): DuplicateCandidate[] => {
    const out: DuplicateCandidate[] = [];
    const seen = new Set<NoteId>();

    for (const hit of hits) {
        if (exclude.has(hit.noteId) || seen.has(hit.noteId)) continue;
        seen.add(hit.noteId);

        const existing = lookup(hit.noteId);
        if (existing === undefined) continue;

        const semantic = hit.components?.semantic?.score;
        const sim = Math.max(similarity(fresh, existing), semantic !== undefined && semantic >= SEMANTIC_DUPLICATE ? semantic : 0);

        if (sim >= DUPLICATE_THRESHOLD) out.push({id: hit.noteId, title: existing.title, similarity: Math.round(sim * 100) / 100});
    }

    return out.sort((x, y) => y.similarity - x.similarity).slice(0, MAX_DUPLICATES);
};
