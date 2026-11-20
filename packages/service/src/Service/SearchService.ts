import type {NoteId, SearchHit, SearchMode, SearchScope} from '@synaipse/core';
import {createLogger, inScope, intersectScopes, isUnscoped} from '@synaipse/core';
import type {Reranker} from '@synaipse/vector';
import {auditContextStorage} from '../AuditContext.js';
import {duplicateQuery, pickDuplicates, type DuplicateCandidate, type DuplicateText} from '../Duplicates.js';
import {annotateSingleSignal, defaultDemote, reciprocalRankFusion, type RankedSignal} from '../Fusion.js';
import {rankByGraphProximity} from '../Graph.js';
import {bestSection, type SectionAnchor} from '../Inbox.js';
import {applyKnowledgeState} from '../KnowledgeState.js';
import type {AuditRecorder} from './AuditRecorder.js';
import type {NoteCore} from './NoteCore.js';
import type {SearchFilter} from './Types.js';
import {MS_PER_DAY} from './Util.js';

const log = createLogger('service');

/**
 * Session context (the `context` signal): the notes read last, if one
 * matches the query, nudge their graph neighbours. Measured with the
 * session and follow-up variants of the eval (P8 / B7, 2026-11-20): with
 * the old setup (last 10 reads as full-weight graph seeds, read notes
 * boosted themselves) a session of unrelated questions dropped hit@1 from
 * 0.83 to 0.59 and put outdated notes above the answer.
 */
const CONTEXT_WINDOW_MS = 7 * MS_PER_DAY;
/** Only the last few reads stand for what the session is about now. */
const CONTEXT_READS = 3;
/**
 * RRF weight of the context signal. One rank step in a text signal is
 * worth ~1/(61·62) ≈ 0.0003, a full-weight signal entry ~0.016: at weight
 * 1 any neighbour of a read note jumped over better text matches. 0.05
 * keeps it to near-ties.
 */
const CONTEXT_WEIGHT = 0.05;

/** Extra search candidates fetched so demoted (outdated) hits can make room. */
const KNOWLEDGE_HEADROOM = 5;

/**
 * Hybrid search: title, BM25, semantic and graph signals fused by RRF,
 * optionally re-ranked by a cross-encoder, then adjusted for knowledge
 * state (superseded/expired notes rank lower).
 */
export class SearchService {
    public constructor(
        private readonly core: NoteCore,
        private readonly audit: AuditRecorder,
        /** Optional cross-encoder that re-orders the top of RRF fusion. Null when disabled. */
        private readonly reranker: Reranker | null,
        /** How many hits to feed the reranker per query. */
        private readonly rerankTopN: number
    ) {}

    private get notes(): NoteCore['notes'] {
        return this.core.notes;
    }

    private get index(): NoteCore['index'] {
        return this.core.index;
    }

    /**
     * Search, optionally inside a path scope (plan P4 / A4). The scope is
     * applied inside every signal (BM25, titles, Qdrant filter) before the
     * cut to `limit`, so a scoped search returns up to `limit` hits from
     * the scope instead of the global top-N minus everything outside.
     * An MCP token's path restriction is added automatically.
     */
    public async search(query: string, mode: SearchMode, limit: number, scope?: SearchScope, filter?: SearchFilter): Promise<SearchHit[]> {
        // A search hit is not an access: counting every hit made notes that
        // rank well rank better (they also became graph seeds of the next
        // search) and kept them out of `stale` without anyone reading them.
        // Reads (readNote, related, backlinks) still count.
        const tokenPrefixes = auditContextStorage.getStore()?.pathPrefixes;
        const effective = intersectScopes(scope, tokenPrefixes !== undefined && tokenPrefixes.length > 0 ? {include: tokenPrefixes} : undefined);
        if (effective === null) return [];

        const scoped = isUnscoped(effective) ? undefined : effective;
        const tags = filter?.tags?.filter((t) => t.length > 0) ?? [];
        const since = filter?.sinceMs;

        if (tags.length === 0 && since === undefined) {
            return this.runSearch(query, mode, limit, scoped);
        }

        // Filters apply after ranking, so fetch a wider candidate set.
        const keep = (id: NoteId): boolean => {
            const note = this.notes.tryGet(id);
            if (note === undefined) return false;
            if (since !== undefined && note.mtime < since) return false;
            return tags.every((t) => note.tags.includes(t.replace(/^#/, '')));
        };
        const wide = await this.runSearch(query, mode, Math.max(limit * 5, 50), scoped);
        return wide.filter((h) => keep(h.noteId)).slice(0, limit);
    }

    /** Where in a note a query lands (see Inbox.bestSection); null for short or unknown notes. */
    public sectionFor(id: NoteId, query: string): SectionAnchor | null {
        const note = this.notes.tryGet(id);
        return note === undefined ? null : bestSection(note.content, query);
    }

    /**
     * Existing notes that look like the same knowledge as `text` (plan
     * P8 / B4): search candidates ranked by word overlap (see
     * Duplicates.ts). Respects the caller's path scope like search.
     */
    public async possibleDuplicates(text: DuplicateText, exclude: readonly NoteId[] = []): Promise<DuplicateCandidate[]> {
        const query = duplicateQuery(text);
        if (query.length === 0) return [];

        const hits = await this.search(query, 'hybrid', 8);
        return pickDuplicates(text, hits, (id) => {
            const note = this.notes.tryGet(id);
            return note === undefined ? undefined : {title: note.title, content: note.content};
        }, new Set(exclude));
    }

    /**
     * Search plus knowledge state (plan P8 / B4): superseded, expired and
     * low-confidence notes rank lower, the successor of a superseded hit
     * takes its place. A few extra candidates let demoted hits make room.
     */
    private async runSearch(query: string, mode: SearchMode, limit: number, scope?: SearchScope): Promise<SearchHit[]> {
        const hits = await this.runSearchSignals(query, mode, limit + KNOWLEDGE_HEADROOM, scope);
        let successors = this.core.successors();

        if (successors.size === 0 && !hits.some((h) => this.mayBeDemoted(h.noteId))) {
            return hits.slice(0, limit);
        }

        if (scope !== undefined) {
            // Never point at (or pull in) a successor outside the caller's scope.
            successors = new Map([...successors].filter(([, to]) => inScope(to, scope)));
        }

        return applyKnowledgeState(hits, limit, (id) => this.notes.tryGet(id), successors, Date.now());
    }

    /** Cheap pre-check: frontmatter that can lower a note's weight. */
    private mayBeDemoted(id: NoteId): boolean {
        const fm = this.notes.tryGet(id)?.frontmatter;
        return fm !== undefined && (fm['valid_until'] !== undefined || typeof fm.confidence === 'number');
    }

    private async runSearchSignals(query: string, mode: SearchMode, limit: number, scope?: SearchScope): Promise<SearchHit[]> {
        const accept = scope === undefined ? undefined : (id: NoteId): boolean => inScope(id, scope);

        if (mode === 'fulltext') {
            return annotateSingleSignal(this.core.fulltext.search(query, limit, accept), 'fulltext');
        }

        if (mode === 'semantic') {
            // Graceful fallback when a semantic-only query lands on an
            // embeddings-disabled service — better to return fulltext hits
            // than an empty list.
            if (this.index === null) {
                return annotateSingleSignal(this.core.fulltext.search(query, limit, accept), 'fulltext');
            }
            const semStart = Date.now();
            const hits = await this.index.semanticSearch(query, limit, scope);
            void this.audit.recordExternalEmbed({
                source: 'search',
                noteIds: [],
                question: query.slice(0, 200),
                durationMs: Date.now() - semStart
            });
            return annotateSingleSignal(hits, 'semantic');
        }

        // hybrid: title + fulltext + (semantic if available) + (graph if seeds)
        const ft = this.core.fulltext.search(query, limit, accept);
        const titles = this.core.fulltext.searchTitle(query, limit, accept);
        let sem: SearchHit[] = [];
        if (this.index !== null) {
            const semStart = Date.now();
            sem = await this.index.semanticSearch(query, limit, scope);
            void this.audit.recordExternalEmbed({
                source: 'search',
                noteIds: [],
                question: query.slice(0, 200),
                durationMs: Date.now() - semStart
            });
        }

        const signals: RankedSignal[] = [
            {name: 'title', hits: titles},
            {name: 'fulltext', hits: ft}
        ];
        if (sem.length > 0) signals.push({name: 'semantic', hits: sem});

        signals.push(...this.buildGraphSignals([titles, sem, ft], limit));

        // Fusion runs at a widened budget when reranking so the cross-
        // encoder gets more candidates to reorder — otherwise it can
        // only shuffle within a set that fusion already trimmed.
        const fusionLimit = this.reranker !== null
            ? Math.max(limit, this.rerankTopN)
            : limit;
        const fused = reciprocalRankFusion(signals, {
            limit: fusionLimit,
            weightFor: defaultDemote((id) => this.notes.tryGet(id))
        });

        if (this.reranker === null || fused.length === 0) {
            return fused.slice(0, limit);
        }

        return this.rerankHits(query, fused, limit);
    }

    /**
     * Cross-encoder re-rank of the top-N RRF hits. Each hit is paired
     * with a passage (its snippet, or a title + content prefix when the
     * signal didn't populate one), and the whole batch is scored in
     * one model call. The final ordering uses the reranker score; the
     * previous fusion components stay on the hit for `explain` output.
     */
    private async rerankHits(
        query: string,
        fused: readonly SearchHit[],
        limit: number
    ): Promise<SearchHit[]> {
        if (this.reranker === null) return fused.slice(0, limit);

        const window = fused.slice(0, this.rerankTopN);
        const rest = fused.slice(this.rerankTopN);

        const passages = window.map((hit) => this.passageFor(hit));

        let scores: number[];
        try {
            scores = await this.reranker.score(query, passages);
        } catch (error) {
            // Rerank is optional — if the model errors we return the
            // pre-rerank fusion order rather than blowing up the whole
            // search. Log once so it doesn't go silent.
            log.warn('reranker failed, falling back to fusion order', {error});
            return fused.slice(0, limit);
        }

        const scored = window.map((hit, i) => ({hit, score: scores[i] ?? 0, origRank: i + 1}));
        scored.sort((a, b) => b.score - a.score);

        const reranked: SearchHit[] = scored.map((entry, idx) => ({
            ...entry.hit,
            score: entry.score,
            components: {
                ...(entry.hit.components ?? {}),
                rerank: {score: entry.score, rank: idx + 1}
            }
        }));

        // Anything past the rerank window keeps its fusion order at the
        // bottom of the list — the reranker can't have opinions about
        // hits it never saw, so we don't reshuffle them.
        return [...reranked, ...rest].slice(0, limit);
    }

    /**
     * Build the passage that goes to the cross-encoder for a given hit.
     * Prefer the snippet (semantic hits carry chunk text), fall back to
     * title + note prefix (fulltext/title/graph hits often carry no
     * snippet). Caps prefix at ~1000 chars so we don't pathologically
     * blow past the reranker's max_length on long notes.
     */
    private passageFor(hit: SearchHit): string {
        if (hit.snippet !== undefined && hit.snippet.length > 0) {
            return hit.snippet;
        }
        const note = this.notes.tryGet(hit.noteId);
        const body = note?.content.slice(0, 1000) ?? '';
        return `${hit.title}\n\n${body}`.trim();
    }

    /**
     * Graph signals over the candidate union of the other signals:
     * `graph` ranks by proximity to pinned notes (as before), `context` by
     * proximity to the notes read last that are candidates themselves, i.e.
     * on this query's topic. A read note gets no bonus for itself (the
     * agent already has it); only its neighbours do. Signals without a
     * seed or a scored candidate are left out.
     */
    private buildGraphSignals(
        candidateLists: readonly (readonly SearchHit[])[],
        limit: number
    ): RankedSignal[] {
        const seen = new Set<NoteId>();
        const candidates: SearchHit[] = [];
        for (const list of candidateLists) {
            for (const hit of list) {
                if (seen.has(hit.noteId)) continue;
                seen.add(hit.noteId);
                candidates.push(hit);
            }
        }

        if (candidates.length === 0) return [];

        const adj = this.core.adjacency();
        const signals: RankedSignal[] = [];

        const pinned = this.pinnedSeeds();
        if (pinned.length > 0) {
            const hits = rankByGraphProximity(candidates, pinned, adj).slice(0, limit);
            if (hits.length > 0) signals.push({name: 'graph', hits});
        }

        const read = this.recentReads().filter((id) => seen.has(id) && !pinned.includes(id));
        if (read.length > 0) {
            const hits = rankByGraphProximity(candidates, read, adj, {seedSelfBonus: 0}).slice(0, limit);
            if (hits.length > 0) signals.push({name: 'context', hits, weight: CONTEXT_WEIGHT});
        }

        return signals;
    }

    /** Notes marked `pinned` or `prime` in their frontmatter. */
    private pinnedSeeds(): NoteId[] {
        return this.notes.list()
            .filter((n) => n.frontmatter['pinned'] === true || n.frontmatter['prime'] === true)
            .map((n) => n.id);
    }

    /** The notes read last (access cache, within {@link CONTEXT_WINDOW_MS}), newest first. */
    private recentReads(): NoteId[] {
        const recent: {id: NoteId; lastAccessed: number}[] = [];
        const cutoff = Date.now() - CONTEXT_WINDOW_MS;
        for (const id of this.notes.entryIds()) {
            const lastAccessed = this.notes.getEntry(id)?.lastAccessed;
            if (lastAccessed === undefined || lastAccessed < cutoff) continue;
            if (this.notes.tryGet(id) === undefined) continue;
            recent.push({id, lastAccessed});
        }

        return recent
            .sort((a, b) => b.lastAccessed - a.lastAccessed)
            .slice(0, CONTEXT_READS)
            .map((r) => r.id);
    }
}
