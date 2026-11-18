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

/** BM25 term-frequency saturation knob. Standard literature value. */
const BM25_K1 = 1.5;
/** BM25 length-normalization knob. 0=no normalization, 1=full. */
const BM25_B = 0.75;
/** Fixed boost added once per query-term-in-title hit. Tuned against BM25 magnitudes. */
const TITLE_BONUS_PER_TERM = 2;

/**
 * Copy of a string that does not share memory with the text it was cut
 * from. Tokens from `split()` can be slices of the whole lower-cased note
 * body; keeping one in the dictionary would pin that body forever.
 */
const detach = (s: string): string => (s.length < 13 ? s : Buffer.from(s, 'utf8').toString('utf8'));

/** Posting value: body hit count in the upper bits, title flag in bit 0. */
const pack = (bodyHits: number, inTitle: boolean): number => ((bodyHits << 1) | (inTitle ? 1 : 0)) >>> 0;

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
 *
 * Memory layout (plan P4 / A4): terms and notes are numbered; each term's
 * postings are one Uint32Array of `[docNo, packed]` pairs, each note's
 * term list one Uint32Array of term numbers. The former
 * `Map<term, Map<noteId, {…}>>` + `Map<noteId, Set<term>>` took 267 MB
 * for a 3 300-note vault, mostly object and Map entry overhead plus term
 * strings that pinned whole lower-cased note bodies.
 */
export class InvertedIndex {
    /** term → term number */
    private readonly termIds = new Map<string, number>();
    /** term number → term (null = free slot) */
    private terms: Array<string | null> = [];
    /** term number → `[docNo, packed, docNo, packed, …]`, in insertion order */
    private postings: Array<Uint32Array | null> = [];
    /** term number → number of pairs used in its postings array */
    private postingCounts: number[] = [];
    private freeTerms: number[] = [];

    /** noteId → doc number */
    private readonly docNos = new Map<NoteId, number>();
    /** doc number → noteId (null = free slot) */
    private docIds: Array<NoteId | null> = [];
    /** doc number → its term numbers (needed when removing the note again) */
    private docTerms: Array<Uint32Array | null> = [];
    private titles: string[] = [];
    private paths: string[] = [];
    /** Cached snippets per note for fast SearchHit construction. */
    private snippets: string[] = [];
    /** Body token count per note — denominator for BM25 length normalization. */
    private docLengths: number[] = [];
    private freeDocs: number[] = [];

    /** Running sum of all docLengths so averageDocLength() is O(1). */
    private totalDocLength = 0;

    public build(notes: Iterable<Note>): void {
        this.termIds.clear();
        this.terms = [];
        this.postings = [];
        this.postingCounts = [];
        this.freeTerms = [];
        this.docNos.clear();
        this.docIds = [];
        this.docTerms = [];
        this.titles = [];
        this.paths = [];
        this.snippets = [];
        this.docLengths = [];
        this.freeDocs = [];
        this.totalDocLength = 0;

        for (const note of notes) {
            this.addNote(note);
        }

        this.trim();
    }

    public addNote(note: Note): void {
        // remove any stale state first (covers re-index)
        this.removeNote(note.id);

        const titleTerms = new Set(tokenise(note.title));

        // count body hits and track length for BM25 normalization
        const bodyCounts = new Map<string, number>();
        let docLength = 0;
        for (const term of tokenise(note.content)) {
            bodyCounts.set(term, (bodyCounts.get(term) ?? 0) + 1);
            docLength += 1;
        }

        const seenTerms = new Set<string>(bodyCounts.keys());
        for (const t of titleTerms) seenTerms.add(t);

        const doc = this.freeDocs.pop() ?? this.docIds.length;
        const termNos = new Uint32Array(seenTerms.size);
        let i = 0;

        for (const term of seenTerms) {
            const termNo = this.termNo(term);
            this.appendPosting(termNo, doc, pack(bodyCounts.get(term) ?? 0, titleTerms.has(term)));
            termNos[i++] = termNo;
        }

        this.docNos.set(note.id, doc);
        this.docIds[doc] = note.id;
        this.docTerms[doc] = termNos;
        this.titles[doc] = note.title;
        this.paths[doc] = note.path;
        this.snippets[doc] = detach(note.content.slice(0, 200));
        this.docLengths[doc] = docLength;
        this.totalDocLength += docLength;
    }

    public removeNote(noteId: NoteId): void {
        const doc = this.docNos.get(noteId);

        if (doc === undefined) return;

        for (const termNo of this.docTerms[doc] ?? []) {
            this.removePosting(termNo, doc);
        }

        this.docNos.delete(noteId);
        this.docIds[doc] = null;
        this.docTerms[doc] = null;
        this.titles[doc] = '';
        this.paths[doc] = '';
        this.snippets[doc] = '';
        this.totalDocLength -= this.docLengths[doc] ?? 0;
        this.docLengths[doc] = 0;
        this.freeDocs.push(doc);
    }

    public size(): number {
        return this.docNos.size;
    }

    public termCount(): number {
        return this.termIds.size;
    }

    /** BM25 ranking. `accept` drops notes before the cut to `limit` (search scope). */
    public search(query: string, limit: number, accept?: (id: NoteId) => boolean): SearchHit[] {
        const terms = tokenise(query);

        if (terms.length === 0) return [];

        const totalDocs = this.docNos.size;
        const avgDocLength = totalDocs === 0 ? 0 : this.totalDocLength / totalDocs;

        const scores = new Map<number, number>();
        const titleHits = new Map<number, number>();

        for (const term of terms) {
            const termNo = this.termIds.get(term);
            if (termNo === undefined) continue;

            const list = this.postings[termNo]!;
            const pairs = this.postingCounts[termNo]!;

            // BM25 IDF — rare terms get more weight. The "+1" form keeps IDF
            // non-negative even when a term shows up in more than half the corpus.
            const df = pairs;
            const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));

            for (let p = 0; p < pairs * 2; p += 2) {
                const doc = list[p]!;
                const packed = list[p + 1]!;
                const tf = packed >>> 1;
                if (tf > 0) {
                    const dl = this.docLengths[doc] ?? 0;
                    const norm = avgDocLength > 0 ? dl / avgDocLength : 1;
                    const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * norm);
                    const bm25 = idf * ((tf * (BM25_K1 + 1)) / denom);
                    scores.set(doc, (scores.get(doc) ?? 0) + bm25);
                }

                if ((packed & 1) === 1) {
                    titleHits.set(doc, (titleHits.get(doc) ?? 0) + 1);
                }
            }
        }

        // Per-query-term-in-title bonus. Tuned to roughly match a strong BM25
        // body hit so a title match consistently outranks raw body chatter.
        for (const [doc, hits] of titleHits) {
            scores.set(doc, (scores.get(doc) ?? 0) + TITLE_BONUS_PER_TERM * hits);
        }

        return this.toHits(scores, limit, accept, (score) => score > 0);
    }

    /** Title-only ranking — used as a third RRF input. */
    public searchTitle(query: string, limit: number, accept?: (id: NoteId) => boolean): SearchHit[] {
        const terms = tokenise(query);

        if (terms.length === 0) return [];

        const counts = new Map<number, number>();

        for (const term of terms) {
            const termNo = this.termIds.get(term);
            if (termNo === undefined) continue;

            const list = this.postings[termNo]!;
            const pairs = this.postingCounts[termNo]!;

            for (let p = 0; p < pairs * 2; p += 2) {
                if ((list[p + 1]! & 1) === 0) continue;
                const doc = list[p]!;
                counts.set(doc, (counts.get(doc) ?? 0) + 1);
            }
        }

        return this.toHits(counts, limit, accept, () => true);
    }

    private toHits(
        scores: Map<number, number>,
        limit: number,
        accept: ((id: NoteId) => boolean) | undefined,
        keep: (score: number) => boolean
    ): SearchHit[] {
        const hits: SearchHit[] = [];

        for (const [doc, score] of scores) {
            if (!keep(score)) continue;
            const noteId = this.docIds[doc];
            if (noteId === null || noteId === undefined) continue;
            if (accept !== undefined && !accept(noteId)) continue;

            hits.push({
                noteId,
                path: this.paths[doc] || noteId,
                title: this.titles[doc] || noteId,
                score,
                snippet: this.snippets[doc] ?? ''
            });
        }

        hits.sort((a, b) => b.score - a.score);
        return hits.slice(0, limit);
    }

    private termNo(term: string): number {
        const known = this.termIds.get(term);
        if (known !== undefined) return known;

        const stored = detach(term);
        const termNo = this.freeTerms.pop() ?? this.terms.length;
        this.termIds.set(stored, termNo);
        this.terms[termNo] = stored;
        this.postings[termNo] = new Uint32Array(2);
        this.postingCounts[termNo] = 0;
        return termNo;
    }

    private appendPosting(termNo: number, doc: number, packed: number): void {
        let list = this.postings[termNo]!;
        const pairs = this.postingCounts[termNo]!;

        if ((pairs + 1) * 2 > list.length) {
            const grown = new Uint32Array(Math.max(4, list.length * 2));
            grown.set(list);
            list = grown;
            this.postings[termNo] = list;
        }

        list[pairs * 2] = doc;
        list[pairs * 2 + 1] = packed;
        this.postingCounts[termNo] = pairs + 1;
    }

    /** Order-preserving removal, so ties keep ranking in insertion order. */
    private removePosting(termNo: number, doc: number): void {
        const list = this.postings[termNo];
        if (list === null || list === undefined) return;
        const pairs = this.postingCounts[termNo]!;

        for (let p = 0; p < pairs * 2; p += 2) {
            if (list[p] !== doc) continue;
            list.copyWithin(p, p + 2, pairs * 2);
            this.postingCounts[termNo] = pairs - 1;
            break;
        }

        if (this.postingCounts[termNo] === 0) {
            this.termIds.delete(this.terms[termNo]!);
            this.terms[termNo] = null;
            this.postings[termNo] = null;
            this.freeTerms.push(termNo);
        }
    }

    /** Drop the growth slack of every postings array (after a full build). */
    private trim(): void {
        for (let t = 0; t < this.postings.length; t++) {
            const list = this.postings[t];
            const used = (this.postingCounts[t] ?? 0) * 2;
            if (list !== null && list !== undefined && list.length > used) {
                this.postings[t] = list.slice(0, used);
            }
        }
    }
}
