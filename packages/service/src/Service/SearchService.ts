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

const GRAPH_SEED_RECENT_WINDOW_MS = 7 * MS_PER_DAY;
const GRAPH_SEED_RECENT_CAP = 10;

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

        const graph = this.buildGraphSignal([titles, sem, ft], limit);
        if (graph !== null) signals.push(graph);

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
     * Construct a graph-proximity signal for the candidate union of the other
     * search signals. Returns null when there are no seed notes (pinned +
     * recently-touched) or no candidate has a positive proximity score — the
     * signal then contributes nothing and isn't added to the fusion.
     */
    private buildGraphSignal(
        candidateLists: readonly (readonly SearchHit[])[],
        limit: number
    ): RankedSignal | null {
        const seeds = this.collectGraphSeeds();
        if (seeds.length === 0) return null;

        const seen = new Set<NoteId>();
        const candidates: SearchHit[] = [];
        for (const list of candidateLists) {
            for (const hit of list) {
                if (seen.has(hit.noteId)) continue;
                seen.add(hit.noteId);
                candidates.push(hit);
            }
        }

        if (candidates.length === 0) return null;

        const hits = rankByGraphProximity(candidates, seeds, this.core.adjacency()).slice(0, limit);
        if (hits.length === 0) return null;

        return {name: 'graph', hits};
    }

    /**
     * Seed set for graph-signal ranking: pinned notes (frontmatter `pinned`
     * or `prime` truthy) plus notes touched recently via the access cache.
     * Capped so the per-candidate AA sum stays bounded.
     */
    private collectGraphSeeds(): NoteId[] {
        const seeds = new Set<NoteId>();

        for (const note of this.notes.list()) {
            const fm = note.frontmatter;
            if (fm['pinned'] === true || fm['prime'] === true) {
                seeds.add(note.id);
            }
        }

        const recent: {id: NoteId; lastAccessed: number}[] = [];
        const cutoff = Date.now() - GRAPH_SEED_RECENT_WINDOW_MS;
        for (const id of this.notes.entryIds()) {
            const entry = this.notes.getEntry(id);
            const lastAccessed = entry?.lastAccessed;
            if (lastAccessed === undefined || lastAccessed < cutoff) continue;
            if (this.notes.tryGet(id) === undefined) continue;
            recent.push({id, lastAccessed});
        }

        recent.sort((a, b) => b.lastAccessed - a.lastAccessed);
        for (const {id} of recent.slice(0, GRAPH_SEED_RECENT_CAP)) {
            seeds.add(id);
        }

        return [...seeds];
    }
}
