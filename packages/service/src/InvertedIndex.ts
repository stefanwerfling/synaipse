import type {Note, NoteId, SearchHit} from '@synaipse/core';

const STOPWORDS = new Set([
    'und', 'oder', 'die', 'der', 'das', 'ein', 'eine', 'wie', 'was', 'wo', 'wer',
    'sind', 'ist', 'sein', 'haben', 'habe', 'hat', 'mit', 'von', 'für', 'auf',
    'an', 'in', 'im', 'aus', 'zu', 'zur', 'zum',
    'the', 'and', 'or', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'for'
]);

const TOKEN_SPLIT = /[\s\-_/.,;:!?()'"`[\]{}<>]+/;

export const tokenise = (text: string): string[] => {
    if (text.length === 0) return [];

    return text
        .toLowerCase()
        .split(TOKEN_SPLIT)
        .filter((t) => t.length > 1 && !STOPWORDS.has(t));
};

interface Posting {
    /** Total body hits across the note (excluding title hits). */
    bodyHits: number;
    /** True if the term also appears in the title. */
    inTitle: boolean;
}

/** BM25 term-frequency saturation knob. Standard literature value. */
const BM25_K1 = 1.5;
/** BM25 length-normalization knob. 0=no normalization, 1=full. */
const BM25_B = 0.75;
/** Fixed boost added once per query-term-in-title hit. Tuned against BM25 magnitudes. */
const TITLE_BONUS_PER_TERM = 2;

/**
 * In-memory inverted index over the vault. Replaces the O(N × content)
 * substring-scan in fulltextSearch with O(terms × postings) lookups so
 * search latency stays sub-millisecond regardless of vault size.
 *
 * Build cost is one-time at startup; addNote/removeNote keep the index
 * in sync with vault changes incrementally.
 *
 * Scoring is Okapi BM25: rare terms dominate via IDF, repeated mentions
 * saturate (k1), and long notes get penalized (b). Without this, a long
 * note that mentions a term 10× incidentally outranks a short focused
 * note that mentions it 5× — the classic "wall of text wins" failure.
 */
export class InvertedIndex {
    /** term → noteId → posting */
    private readonly postings = new Map<string, Map<NoteId, Posting>>();

    /** Per-note metadata snapshot needed when removing terms again. */
    private readonly noteTerms = new Map<NoteId, Set<string>>();

    /** Cached snippets per note for fast SearchHit construction. */
    private readonly snippets = new Map<NoteId, string>();

    /** Cached titles for SearchHit.title. */
    private readonly titles = new Map<NoteId, string>();

    /** Cached paths for SearchHit.path. */
    private readonly paths = new Map<NoteId, string>();

    /** Body token count per note — denominator for BM25 length normalization. */
    private readonly docLengths = new Map<NoteId, number>();

    /** Running sum of all docLengths so averageDocLength() is O(1). */
    private totalDocLength = 0;

    public build(notes: Iterable<Note>): void {
        this.postings.clear();
        this.noteTerms.clear();
        this.snippets.clear();
        this.titles.clear();
        this.paths.clear();
        this.docLengths.clear();
        this.totalDocLength = 0;

        for (const note of notes) {
            this.addNote(note);
        }
    }

    public addNote(note: Note): void {
        // remove any stale state first (covers re-index)
        this.removeNote(note.id);

        const titleTerms = new Set(tokenise(note.title));
        const seenTerms = new Set<string>();

        // count body hits and track length for BM25 normalization
        const bodyCounts = new Map<string, number>();
        let docLength = 0;
        for (const term of tokenise(note.content)) {
            bodyCounts.set(term, (bodyCounts.get(term) ?? 0) + 1);
            seenTerms.add(term);
            docLength += 1;
        }

        for (const t of titleTerms) seenTerms.add(t);

        for (const term of seenTerms) {
            const bucket = this.postings.get(term) ?? new Map<NoteId, Posting>();
            bucket.set(note.id, {
                bodyHits: bodyCounts.get(term) ?? 0,
                inTitle: titleTerms.has(term)
            });
            this.postings.set(term, bucket);
        }

        this.noteTerms.set(note.id, seenTerms);
        this.titles.set(note.id, note.title);
        this.paths.set(note.id, note.path);
        this.snippets.set(note.id, note.content.slice(0, 200));
        this.docLengths.set(note.id, docLength);
        this.totalDocLength += docLength;
    }

    public removeNote(noteId: NoteId): void {
        const terms = this.noteTerms.get(noteId);

        if (terms === undefined) return;

        for (const term of terms) {
            const bucket = this.postings.get(term);
            if (bucket === undefined) continue;
            bucket.delete(noteId);
            if (bucket.size === 0) this.postings.delete(term);
        }

        this.noteTerms.delete(noteId);
        this.titles.delete(noteId);
        this.paths.delete(noteId);
        this.snippets.delete(noteId);

        const docLength = this.docLengths.get(noteId);
        if (docLength !== undefined) {
            this.totalDocLength -= docLength;
            this.docLengths.delete(noteId);
        }
    }

    public size(): number {
        return this.noteTerms.size;
    }

    public termCount(): number {
        return this.postings.size;
    }

    public search(query: string, limit: number): SearchHit[] {
        const terms = tokenise(query);

        if (terms.length === 0) return [];

        const totalDocs = this.noteTerms.size;
        const avgDocLength = totalDocs === 0 ? 0 : this.totalDocLength / totalDocs;

        const scores = new Map<NoteId, number>();
        const titleHits = new Map<NoteId, number>();

        for (const term of terms) {
            const bucket = this.postings.get(term);
            if (bucket === undefined) continue;

            // BM25 IDF — rare terms get more weight. The "+1" form keeps IDF
            // non-negative even when a term shows up in more than half the corpus.
            const df = bucket.size;
            const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));

            for (const [noteId, posting] of bucket) {
                const tf = posting.bodyHits;
                if (tf > 0) {
                    const dl = this.docLengths.get(noteId) ?? 0;
                    const norm = avgDocLength > 0 ? dl / avgDocLength : 1;
                    const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * norm);
                    const bm25 = idf * ((tf * (BM25_K1 + 1)) / denom);
                    scores.set(noteId, (scores.get(noteId) ?? 0) + bm25);
                }

                if (posting.inTitle) {
                    titleHits.set(noteId, (titleHits.get(noteId) ?? 0) + 1);
                }
            }
        }

        // Per-query-term-in-title bonus. Tuned to roughly match a strong BM25
        // body hit so a title match consistently outranks raw body chatter.
        for (const [noteId, hits] of titleHits) {
            scores.set(noteId, (scores.get(noteId) ?? 0) + TITLE_BONUS_PER_TERM * hits);
        }

        const hits: SearchHit[] = [];

        for (const [noteId, score] of scores) {
            if (score <= 0) continue;

            hits.push({
                noteId,
                path: this.paths.get(noteId) ?? noteId,
                title: this.titles.get(noteId) ?? noteId,
                score,
                snippet: this.snippets.get(noteId) ?? ''
            });
        }

        hits.sort((a, b) => b.score - a.score);
        return hits.slice(0, limit);
    }

    /** Title-only ranking — used as a third RRF input. */
    public searchTitle(query: string, limit: number): SearchHit[] {
        const terms = tokenise(query);

        if (terms.length === 0) return [];

        const counts = new Map<NoteId, number>();

        for (const term of terms) {
            const bucket = this.postings.get(term);
            if (bucket === undefined) continue;

            for (const [noteId, posting] of bucket) {
                if (!posting.inTitle) continue;
                counts.set(noteId, (counts.get(noteId) ?? 0) + 1);
            }
        }

        const hits: SearchHit[] = [];

        for (const [noteId, score] of counts) {
            hits.push({
                noteId,
                path: this.paths.get(noteId) ?? noteId,
                title: this.titles.get(noteId) ?? noteId,
                score,
                snippet: this.snippets.get(noteId) ?? ''
            });
        }

        hits.sort((a, b) => b.score - a.score);
        return hits.slice(0, limit);
    }
}