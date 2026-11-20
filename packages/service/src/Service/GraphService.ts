import type {Note, NoteId, SearchHit, SearchScope} from '@synaipse/core';
import {createLogger, extractTypedLinks} from '@synaipse/core';
import {extractEntitySpans} from '../EntityLinker.js';
import {type GraphLayout} from '../Layout.js';
import {LayoutComputer} from '../LayoutComputer.js';
import {buildLocalGraph, type LocalGraph, type LocalGraphOptions} from '../LocalGraph.js';
import type {AuditRecorder} from './AuditRecorder.js';
import type {NoteCore} from './NoteCore.js';
import type {LinkSuggestion, RelatedNote, SuggestLinksOptions} from './Types.js';
import {SEMANTIC_SAMPLE_CHARS} from './Util.js';

const log = createLogger('service');

/** Quiet period after the last topology change before the Atlas layout is recomputed. */
const LAYOUT_DEBOUNCE_MS = 750;

const ENTITY_SAMPLE_CHARS = 4000;
const ENTITY_SCORE_BASE = 0.35;
const ENTITY_SCORE_STEP = 0.15;
const ENTITY_SCORE_CAP = 0.9;

/**
 * Everything built on the link topology: the local graph, the Atlas
 * layout (off-thread, stale-while-revalidate), related notes and link
 * suggestions (cached per topology generation).
 */
export class GraphService {
    /** Last computed Atlas layout; kept (stale) across topology changes until the recompute lands. */
    private cachedLayout: GraphLayout | null = null;
    /** Topology generation the cached layout was computed for. */
    private cachedLayoutGen = -1;
    private layoutJob: Promise<GraphLayout> | null = null;
    private layoutTimer: NodeJS.Timeout | null = null;
    private readonly layoutComputer = new LayoutComputer();
    /** suggestLinks results per option set, tagged with the topology generation. */
    private readonly suggestCache = new Map<string, {gen: number; value: LinkSuggestion[]}>();
    private readonly suggestJobs = new Map<string, Promise<LinkSuggestion[]>>();

    public constructor(
        private readonly core: NoteCore,
        private readonly audit: AuditRecorder
    ) {
        core.onInvalidate(() => this.scheduleLayoutRecompute());
    }

    private get notes(): NoteCore['notes'] {
        return this.core.notes;
    }

    private get index(): NoteCore['index'] {
        return this.core.index;
    }

    private get topologyGen(): number {
        return this.core.version();
    }

    /** Build the graph now and the Atlas layout in the background, so the first request is fast. */
    public warm(): void {
        const started = Date.now();
        const graph = this.core.graph();
        log.info('graph cache warmed', {nodes: graph.nodes.length, edges: graph.edges.length, ms: Date.now() - started});

        void this.recomputeLayout().then(
            () => log.info('layout warmed', {ms: Date.now() - started, offThread: this.layoutComputer.offThread}),
            (error: unknown) => log.warn('layout warm-up failed', {error: error instanceof Error ? error.message : String(error)})
        );
    }

    public async close(): Promise<void> {
        if (this.layoutTimer !== null) {
            clearTimeout(this.layoutTimer);
            this.layoutTimer = null;
        }
        await this.layoutComputer.close();
    }

    /**
     * Ego network of a note for the viewer's local graph: wikilinks in both
     * directions plus outgoing typed frontmatter links, bounded by depth and
     * node count. A UI read — it does not count as an access (decay), like
     * the whole-graph endpoint. Null for an unknown id.
     */
    public localGraph(id: NoteId, options: LocalGraphOptions = {}): LocalGraph | null {
        const keys = this.core.linkKeyMap();

        return buildLocalGraph(this.core.graph(), (noteId) => {
            const note = this.notes.tryGet(noteId);
            if (note === undefined) return [];
            return extractTypedLinks(note.frontmatter)
                .map((link) => ({to: keys.get(link.target), kind: link.kind}))
                .filter((link): link is {to: NoteId; kind: typeof link.kind} => link.to !== undefined);
        }, id, options);
    }

    /**
     * Atlas layout (Louvain + tiles), computed off the main thread (plan
     * P4 / A3). Stale-while-revalidate: after a topology change callers
     * get the previous layout with `stale: true` right away while a
     * debounced recompute runs; only the very first call waits.
     */
    public async graphLayout(): Promise<GraphLayout & {stale?: boolean}> {
        if (this.cachedLayout !== null && this.cachedLayoutGen === this.topologyGen) {
            return this.cachedLayout;
        }

        // An empty stale layout is useless to show; wait for the real one.
        if (this.cachedLayout !== null && (this.cachedLayout.nodes.length > 0 || this.core.graph().nodes.length === 0)) {
            if (this.layoutJob === null && this.layoutTimer === null) {
                this.scheduleLayoutRecompute();
            }
            return {...this.cachedLayout, stale: true};
        }

        return this.recomputeLayout();
    }

    private scheduleLayoutRecompute(): void {
        if (this.cachedLayout === null && this.layoutJob === null) {
            // Nothing was ever computed or requested: stay lazy.
            return;
        }

        if (this.layoutTimer !== null) {
            clearTimeout(this.layoutTimer);
        }

        // Debounced: a burst of writes (import, crawl) recomputes once.
        this.layoutTimer = setTimeout(() => {
            this.layoutTimer = null;
            void this.recomputeLayout().catch((error: unknown) => {
                log.warn('layout recompute failed', {error: error instanceof Error ? error.message : String(error)});
            });
        }, LAYOUT_DEBOUNCE_MS);
        this.layoutTimer.unref();
    }

    /** Compute for the current topology; joins a running job and re-runs if topology moved on meanwhile. */
    private async recomputeLayout(): Promise<GraphLayout> {
        while (this.layoutJob !== null) {
            await this.layoutJob.catch(() => undefined);
        }

        if (this.cachedLayout !== null && this.cachedLayoutGen === this.topologyGen) {
            return this.cachedLayout;
        }

        const gen = this.topologyGen;
        const data = this.core.graph();
        const job = this.layoutComputer.compute(data);
        this.layoutJob = job;

        try {
            const layout = await job;
            // Even when the topology moved on meanwhile, a newer-but-stale
            // layout beats an older one; the scheduled recompute catches up.
            this.cachedLayout = layout;
            this.cachedLayoutGen = gen;
            return layout;
        } finally {
            this.layoutJob = null;
        }
    }

    public async related(id: NoteId, limit = 10): Promise<RelatedNote[]> {
        const note = this.notes.tryGet(id);

        if (note === undefined) {
            return [];
        }

        this.core.touchAccess(note);

        const accumulator = new Map<NoteId, {score: number; reasons: Set<string>}>();

        const add = (otherId: NoteId, weight: number, reason: string): void => {
            if (otherId === id || weight <= 0) {
                return;
            }

            const entry = accumulator.get(otherId) ?? {score: 0, reasons: new Set<string>()};
            entry.score += weight;
            entry.reasons.add(reason);
            accumulator.set(otherId, entry);
        };

        if (this.index !== null && note.content.length > 0) {
            const sample = note.content.slice(0, SEMANTIC_SAMPLE_CHARS);
            const embedStart = Date.now();
            const hits = await this.index.semanticSearch(sample, limit * 2);
            void this.audit.recordExternalEmbed({
                source: 'related',
                noteIds: [note.id],
                question: sample.slice(0, 200),
                durationMs: Date.now() - embedStart
            });

            for (const hit of hits) {
                add(hit.noteId, hit.score, 'semantic');
            }
        }

        const keyToId = this.core.linkKeyMap();

        for (const link of note.wikilinks) {
            const targetId = keyToId.get(link);

            if (targetId !== undefined) {
                add(targetId, 0.6, 'wikilink-out');
            }
        }

        for (const backlinkId of this.core.backlinks(id)) {
            add(backlinkId, 0.6, 'wikilink-in');
        }

        const myTags = new Set(note.tags);

        if (myTags.size > 0) {
            for (const other of this.notes.list()) {
                if (other.id === id) {
                    continue;
                }

                const shared = other.tags.filter((t) => myTags.has(t));

                if (shared.length === 0) {
                    continue;
                }

                if (shared.length >= 2) {
                    add(other.id, shared.length * 0.25, `tags:${shared.join(',')}`);
                } else {
                    add(other.id, 0.12, `tag:${shared[0] ?? ''}`);
                }
            }
        }

        return [...accumulator.entries()]
            .map(([otherId, {score, reasons}]) => {
                const other = this.notes.tryGet(otherId);
                return {
                    id: otherId,
                    title: other?.title ?? otherId,
                    score,
                    reasons: [...reasons]
                };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    /**
     * Unlinked note pairs that look related. Results are cached per
     * options and vault generation (plan P4 / A3): after a write the
     * previous result is returned right away, minus pairs that are now
     * linked, while a recompute runs in the background. Only the first
     * call for a given option set waits.
     */
    public async suggestLinks(opts: SuggestLinksOptions = {}): Promise<LinkSuggestion[]> {
        const key = JSON.stringify([opts.limit ?? 20, opts.minScore ?? 0.65, opts.pathPrefix ?? '']);
        const cached = this.suggestCache.get(key);

        if (cached !== undefined && cached.gen === this.topologyGen) {
            return cached.value.map((s) => ({...s, reasons: [...s.reasons]}));
        }

        const job = this.suggestJobs.get(key) ?? this.startSuggestJob(key, opts);

        if (cached === undefined) {
            return (await job).map((s) => ({...s, reasons: [...s.reasons]}));
        }

        void job.catch(() => undefined);
        return cached.value
            .filter((s) => !this.isLinkedPair(s.a, s.b))
            .map((s) => ({...s, reasons: [...s.reasons]}));
    }

    private startSuggestJob(key: string, opts: SuggestLinksOptions): Promise<LinkSuggestion[]> {
        const gen = this.topologyGen;
        const started = Date.now();
        const job = this.computeLinkSuggestions(opts).then((value) => {
            this.suggestCache.set(key, {gen, value});
            log.debug('link suggestions computed', {ms: Date.now() - started, count: value.length});
            return value;
        }).finally(() => {
            this.suggestJobs.delete(key);
        });

        this.suggestJobs.set(key, job);
        return job;
    }

    /** True when either note wikilinks the other (resolved through titles/aliases). */
    private isLinkedPair(a: NoteId, b: NoteId): boolean {
        const keyToId = this.core.linkKeyMap();
        const links = (from: NoteId, to: NoteId): boolean =>
            (this.notes.tryGet(from)?.wikilinks ?? []).some((link) => keyToId.get(link) === to);
        return links(a, b) || links(b, a);
    }

    private async computeLinkSuggestions(opts: SuggestLinksOptions): Promise<LinkSuggestion[]> {
        const limit = opts.limit ?? 20;
        const minScore = opts.minScore ?? 0.65;
        const prefix = opts.pathPrefix ?? '';

        const allNotes = this.notes.list();
        const scoped = prefix.length === 0
            ? allNotes
            : allNotes.filter((n) => n.id.startsWith(prefix));

        if (scoped.length < 2) {
            return [];
        }

        const keyToId = this.core.linkKeyMap();

        const linkedSet = (note: Note): Set<NoteId> => {
            const set = new Set<NoteId>([note.id]);

            for (const link of note.wikilinks) {
                const targetId = keyToId.get(link);

                if (targetId !== undefined) {
                    set.add(targetId);
                }
            }

            for (const backlinkId of this.notes.backlinksOf(note.id)) {
                set.add(backlinkId);
            }

            return set;
        };

        const suggestions = new Map<string, LinkSuggestion>();
        const pairKey = (x: NoteId, y: NoteId): string => x < y ? `${x}|${y}` : `${y}|${x}`;

        const recordPair = (
            aId: NoteId,
            bId: NoteId,
            score: number,
            reason: string,
            sharedTags?: string[]
        ): void => {
            const a = this.notes.tryGet(aId);
            const b = this.notes.tryGet(bId);

            if (a === undefined || b === undefined) {
                return;
            }

            const key = pairKey(aId, bId);
            const existing = suggestions.get(key);

            if (existing !== undefined) {
                if (score > existing.score) {
                    existing.score = score;
                }

                if (!existing.reasons.includes(reason)) {
                    existing.reasons.push(reason);
                }

                if (sharedTags !== undefined && existing.sharedTags === undefined) {
                    existing.sharedTags = sharedTags;
                }

                return;
            }

            suggestions.set(key, {
                a: aId,
                aTitle: a.title,
                b: bId,
                bTitle: b.title,
                score,
                reasons: [reason],
                ...(sharedTags !== undefined ? {sharedTags} : {})
            });
        };

        if (this.index !== null) {
            // suggestLinks loops the whole scope and embeds each note's sample
            // separately. We aggregate into a single audit entry — otherwise a
            // 500-note vault produces 500 log lines for one user action.
            const embedSourceNotes: NoteId[] = [];
            const embedStart = Date.now();
            let embedCalls = 0;
            const withContent = scoped.filter((n) => n.content.length > 0);
            // With a prefix the partner must be inside it too: ask the store
            // for in-scope neighbours instead of the global top 20, which in
            // a big vault are mostly elsewhere (plan P4 / A4).
            const hitScope: SearchScope | undefined = prefix.length > 0 ? {include: [prefix]} : undefined;

            // Stored first-chunk vectors answer most notes without any
            // embedding call (one batched Qdrant request per 64 notes).
            let stored = new Map<NoteId, SearchHit[]>();
            try {
                stored = await this.index.similarToNotes(withContent.map((n) => n.id), 20, hitScope);
            } catch (error) {
                log.warn('stored-vector similarity failed, embedding samples instead', {error});
            }

            for (const note of withContent) {
                const linked = linkedSet(note);
                let hits = stored.get(note.id);

                if (hits === undefined) {
                    // Not embedded yet (or no store support): embed a sample.
                    hits = await this.index.semanticSearch(note.content.slice(0, SEMANTIC_SAMPLE_CHARS), 20, hitScope);
                    embedCalls += 1;
                    embedSourceNotes.push(note.id);
                }

                const seen = new Set<NoteId>();

                for (const hit of hits) {
                    if (seen.has(hit.noteId) || hit.noteId === note.id) {
                        continue;
                    }

                    seen.add(hit.noteId);

                    if (linked.has(hit.noteId)) {
                        continue;
                    }

                    if (hit.score < minScore) {
                        continue;
                    }

                    if (prefix.length > 0 && !hit.noteId.startsWith(prefix)) {
                        continue;
                    }

                    recordPair(note.id, hit.noteId, hit.score, 'semantic');
                }
            }

            if (embedCalls > 0) {
                void this.audit.recordExternalEmbed({
                    source: 'suggest-links',
                    noteIds: embedSourceNotes,
                    embedCalls,
                    durationMs: Date.now() - embedStart
                });
            }
        }

        // Entity-match signal: extract proper-noun-like spans from each
        // note's body and check them against other notes' titles in scope.
        // Catches unlinked mentions that share no tags and aren't close
        // enough in embedding space to surface as "semantic" — e.g. a
        // one-line reference to a tool/concept that has its own note.
        // Extraction is deliberately coarse (see EntityLinker.ts); precision
        // comes entirely from requiring an exact title match, so
        // over-inclusive spans that match nothing are harmless.
        //
        // Deliberately titles only, not frontmatter aliases: measured
        // against the real synaipse-vault (~2.8k notes), short convenience
        // aliases (e.g. "setup", "install", "ACL") were the single biggest
        // source of noise — generic words that happen to double as an
        // alias match constantly against unrelated prose. A single-word
        // *title* that collides with a common word (e.g. a note literally
        // titled "MEMORY") is a smaller residual version of the same
        // problem; it isn't filtered here and shows up as low-score noise
        // rather than being fully solved.
        {
            const entityIndex = new Map<string, NoteId>();

            for (const note of scoped) {
                if (note.title.length > 0 && !entityIndex.has(note.title.toLowerCase())) {
                    entityIndex.set(note.title.toLowerCase(), note.id);
                }
            }

            for (const note of scoped) {
                if (note.content.length === 0) {
                    continue;
                }

                const linked = linkedSet(note);
                const sample = note.content.slice(0, ENTITY_SAMPLE_CHARS);
                const spans = extractEntitySpans(sample);
                const matchedByTarget = new Map<NoteId, Set<string>>();

                for (const span of spans) {
                    const targetId = entityIndex.get(span.toLowerCase());

                    if (targetId === undefined || linked.has(targetId)) {
                        continue;
                    }

                    const entities = matchedByTarget.get(targetId) ?? new Set<string>();
                    entities.add(span);
                    matchedByTarget.set(targetId, entities);
                }

                for (const [targetId, entities] of matchedByTarget) {
                    const score = Math.min(
                        ENTITY_SCORE_CAP,
                        ENTITY_SCORE_BASE + ENTITY_SCORE_STEP * (entities.size - 1)
                    );
                    const reason = `entity:${[...entities].sort().join(',')}`;
                    recordPair(note.id, targetId, score, reason);
                }
            }
        }

        // Tag overlap via an inverted index (plan P4 / A3): only pairs that
        // actually share a tag are visited, instead of all N² pairs. Pairs
        // are recorded in the same (i, j) order as the old double loop, so
        // ties sort identically.
        {
            const byTag = new Map<string, number[]>();

            scoped.forEach((note, i) => {
                if (note.tags.length < 2) return;
                for (const tag of new Set(note.tags)) {
                    const list = byTag.get(tag) ?? [];
                    list.push(i);
                    byTag.set(tag, list);
                }
            });

            const sharedCount = new Map<number, number>();
            const n = scoped.length;

            for (const indices of byTag.values()) {
                for (let x = 0; x < indices.length; x++) {
                    for (let y = x + 1; y < indices.length; y++) {
                        const pair = indices[x]! * n + indices[y]!;
                        sharedCount.set(pair, (sharedCount.get(pair) ?? 0) + 1);
                    }
                }
            }

            const pairs = [...sharedCount.entries()]
                .filter(([, count]) => count >= 2)
                .map(([pair]) => pair)
                .sort((x, y) => x - y);
            const linkedCache = new Map<number, Set<NoteId>>();

            for (const pair of pairs) {
                const i = Math.floor(pair / n);
                const a = scoped[i]!;
                const b = scoped[pair % n]!;
                let aLinked = linkedCache.get(i);

                if (aLinked === undefined) {
                    aLinked = linkedSet(a);
                    linkedCache.set(i, aLinked);
                }

                if (aLinked.has(b.id)) {
                    continue;
                }

                const aTagSet = new Set(a.tags);
                const shared = b.tags.filter((t) => aTagSet.has(t));
                const score = Math.min(0.95, 0.5 + 0.1 * shared.length);
                recordPair(a.id, b.id, score, 'tag-overlap', shared);
            }
        }

        return [...suggestions.values()]
            .sort((x, y) => y.score - x.score)
            .slice(0, limit);
    }
}
