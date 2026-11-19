import type {Graph, Note, NoteAdapter, NoteId} from '@synaipse/core';
import {buildLinkKeyMap, createLogger, LEGACY_EMBED_MODEL} from '@synaipse/core';
import {currentWriteBatch, runWriteBatch, type WriteBatch} from '@synaipse/vault';
import type {VectorIndex} from '@synaipse/vector';
import {buildAdjacency, type AdjacencyMap} from '../Graph.js';
import {InvertedIndex} from '../InvertedIndex.js';
import {buildSuccessors, knowledgeStateOf, type KnowledgeState} from '../KnowledgeState.js';
import type {IndexingStats} from './Types.js';
import {EMBED_GROUP} from './Util.js';

const log = createLogger('service');

export interface NoteCoreOptions {
    notes: NoteAdapter;
    /** Null when embeddings are off (fulltext only). */
    index: VectorIndex | null;
    /** Embedder fingerprint; null exactly when `index` is null. */
    embedModel: string | null;
    embedExcludePrefixes: readonly string[];
}

/**
 * The state every part of the service shares (plan P7 / D2): the note
 * adapter, both search indexes, the embedding bookkeeping and the
 * caches derived from the link topology. Everything that changes notes
 * reports back here, so the indexes and caches stay in step.
 */
export class NoteCore {
    public readonly notes: NoteAdapter;
    public readonly index: VectorIndex | null;
    public readonly embedModel: string | null;
    public readonly fulltext = new InvertedIndex();
    private readonly embedExcludePrefixes: readonly string[];
    /** Notes whose last embed attempt failed; retried on their next write and on start. */
    private readonly pendingEmbeds = new Set<NoteId>();
    private lastStats: IndexingStats = {total: 0, reindexed: 0, removed: 0, unchanged: 0, pending: 0};
    /** Bumped on every topology change. */
    private topologyGen = 0;
    private cachedGraph: Graph | null = null;
    private cachedAdjacency: AdjacencyMap | null = null;
    private cachedLinkKeys: Map<string, NoteId> | null = null;
    /** Superseded note → successor (plan P8 / B4), rebuilt after topology changes. */
    private cachedSuccessors: Map<NoteId, NoteId> | null = null;
    /** Service-internal reactions (layout recompute); run before the public listeners. */
    private readonly invalidateHooks: Array<() => void> = [];
    private readonly topologyListeners = new Set<(version: number) => void>();

    public constructor(opts: NoteCoreOptions) {
        this.notes = opts.notes;
        this.index = opts.index;
        this.embedModel = opts.embedModel;
        this.embedExcludePrefixes = opts.embedExcludePrefixes;
    }

    public stats(): IndexingStats {
        return this.lastStats;
    }

    // --- indexing ----------------------------------------------------------

    private shouldEmbed(noteId: NoteId): boolean {
        return !this.embedExcludePrefixes.some((p) => noteId.startsWith(p));
    }

    /**
     * True when the vector store does not (yet) hold this exact note
     * content for the configured embedder. Legacy entries (embedded before
     * the fingerprint was tracked) count as embedded.
     */
    private needsEmbedding(note: Note): boolean {
        const entry = this.notes.getEntry(note.id);
        if (entry === undefined || entry.embeddedHash !== note.hash) return true;
        if (entry.embedModel === LEGACY_EMBED_MODEL) return false;
        return entry.embedModel !== this.embedModel;
    }

    private setPending(): void {
        this.lastStats = {...this.lastStats, pending: this.pendingEmbeds.size};
    }

    /**
     * Embed one note after a write. Never throws: the note is already
     * persisted, and failing the write because the embedder is down would
     * make callers (LLMs especially) retry and duplicate it. The note stays
     * marked as not-embedded and is retried on its next write and on start.
     */
    public async maybeIndexNote(note: Note): Promise<void> {
        const batch = currentWriteBatch();
        if (batch !== undefined && this.index !== null && this.embedModel !== null && this.shouldEmbed(note.id)) {
            // Embedded in groups when the batch ends (see batch()).
            batch.deferEmbed(note);
        } else if (this.index !== null && this.embedModel !== null && this.shouldEmbed(note.id)) {
            try {
                await this.index.indexNote(note);
                this.notes.recordEmbedded(note.id, note.hash, this.embedModel);
                if (this.pendingEmbeds.delete(note.id)) {
                    this.setPending();
                }
            } catch (error) {
                this.pendingEmbeds.add(note.id);
                this.setPending();
                log.warn('embedding failed; note is saved, vector index catches up on next write or start', {
                    noteId: note.id, error, pending: this.pendingEmbeds.size
                });
            }
        }

        this.invalidateTopology();
    }

    /** After a note was written: vector index (or the batch) plus fulltext. */
    public async indexWritten(note: Note): Promise<void> {
        await this.maybeIndexNote(note);
        this.fulltext.addNote(note);
    }

    /** After a note was deleted: drop it from both indexes. Topology is NOT invalidated here. */
    public async removeIndexed(id: NoteId): Promise<void> {
        if (this.index !== null) {
            await this.index.deleteNote(id);
        }
        this.fulltext.removeNote(id);
    }

    /**
     * Run many writes as one unit (plan P1 / A1): every write inside `fn`
     * still lands on disk and in the in-memory indexes immediately, but
     * versioning, embedding and the index-cache flush happen ONCE at the
     * end — one ngit commit, embeddings in groups of {@link EMBED_GROUP}.
     *
     * The batch is bound to the async context of `fn`: concurrent writes
     * from other callers are unaffected. A nested call joins the outer
     * batch. Side effects run even if `fn` throws (the writes it made are
     * on disk and must be versioned and indexed).
     */
    public async batch<T>(fn: () => Promise<T>, opts: {message?: string; author?: {name: string; email: string}} = {}): Promise<T> {
        return runWriteBatch(fn, (batch) => this.finishBatch(batch, opts));
    }

    private async finishBatch(batch: WriteBatch, opts: {message?: string; author?: {name: string; email: string}}): Promise<void> {
        if (this.notes.commitBatch !== undefined) {
            await this.notes.commitBatch(batch, {
                ...(opts.message !== undefined ? {message: opts.message} : {}),
                ...(opts.author !== undefined ? {author: opts.author} : {})
            });
        }

        // Latest version of each note that still exists.
        const notes = [...batch.embeds.keys()]
            .map((id) => this.notes.tryGet(id))
            .filter((n): n is Note => n !== undefined);

        if (this.index !== null && this.embedModel !== null) {
            for (let i = 0; i < notes.length; i += EMBED_GROUP) {
                const group = notes.slice(i, i + EMBED_GROUP);
                try {
                    await this.index.indexNotes(group);
                } catch (error) {
                    for (const note of notes.slice(i)) this.pendingEmbeds.add(note.id);
                    this.setPending();
                    log.warn('batch embedding failed; notes saved but not embedded, retried on next write or start', {
                        notes: notes.length - i, error
                    });
                    break;
                }
                for (const note of group) {
                    this.notes.recordEmbedded(note.id, note.hash, this.embedModel);
                    this.pendingEmbeds.delete(note.id);
                }
                this.setPending();
            }
        }

        if (batch.size > 0 || notes.length > 0) {
            await this.notes.flushEntries();
        }
    }

    /**
     * Start-up indexing: build the fulltext index, then bring the vector
     * index in line with the vault (embed new/changed notes, drop orphans).
     */
    public async indexAll(): Promise<void> {
        this.fulltext.build(this.notes.list());
        log.info('fulltext index built', {notes: this.fulltext.size(), terms: this.fulltext.termCount()});

        if (this.index === null || this.embedModel === null) {
            log.info('embeddings disabled (provider=none) — fulltext only', {notes: this.notes.list().length});
            return;
        }

        if (this.embedExcludePrefixes.length > 0) {
            log.info('embed exclude prefixes', {prefixes: this.embedExcludePrefixes});
        }

        const embedModel = this.embedModel;
        const stats: IndexingStats = {total: 0, reindexed: 0, removed: 0, unchanged: 0, pending: 0};
        const liveIds = new Set<NoteId>();
        const toReindex: Note[] = [];
        let excluded = 0;

        for (const note of this.notes.list()) {
            stats.total += 1;
            liveIds.add(note.id);

            if (!this.shouldEmbed(note.id)) {
                excluded += 1;
                continue;
            }

            if (!this.needsEmbedding(note)) {
                // Adopt legacy entries under the current fingerprint so a
                // later model switch is detected for them too.
                if (this.notes.getEntry(note.id)?.embedModel === LEGACY_EMBED_MODEL) {
                    this.notes.recordEmbedded(note.id, note.hash, embedModel);
                }
                stats.unchanged += 1;
                continue;
            }

            toReindex.push(note);
        }

        if (excluded > 0) {
            log.info('embed: notes skipped by exclude-prefix', {excluded});
        }

        const orphans: NoteId[] = this.notes.entryIds().filter((id) => !liveIds.has(id));

        // Embed in groups and persist after each one: a crash or embedder
        // outage during a long first index keeps the progress made so far
        // instead of restarting from zero. If the embedder is unreachable,
        // stop early and serve fulltext — the rest is retried next start.
        let chunksEmbedded = 0;
        let chunksReused = 0;

        for (let i = 0; i < toReindex.length; i += EMBED_GROUP) {
            const group = toReindex.slice(i, i + EMBED_GROUP);

            try {
                const result = await this.index.indexNotes(group);
                chunksEmbedded += result.embedded;
                chunksReused += result.reused;
            } catch (error) {
                for (const note of toReindex.slice(i)) this.pendingEmbeds.add(note.id);
                log.warn('embedding failed; remaining notes stay un-embedded (fulltext only) and are retried on next start', {
                    notes: toReindex.length - i, error
                });
                break;
            }

            for (const note of group) {
                this.notes.recordEntry(note.id, note.hash, note.mtime);
                this.notes.recordEmbedded(note.id, note.hash, embedModel);
            }

            stats.reindexed += group.length;
            await this.notes.flushEntries();
        }

        stats.pending = this.pendingEmbeds.size;

        if (chunksEmbedded + chunksReused > 0) {
            log.info('chunks embedded', {embedded: chunksEmbedded, reused: chunksReused});
        }

        if (orphans.length > 0) {
            await this.index.deleteNotes(orphans);

            for (const id of orphans) {
                this.notes.removeEntry(id);
            }

            stats.removed = orphans.length;
        }

        await this.notes.flushEntries();
        this.lastStats = stats;

        log.info('indexed', {reindexed: stats.reindexed, unchanged: stats.unchanged, removed: stats.removed, pending: stats.pending, total: stats.total});
    }

    /** A file was deleted outside Synaipse (watcher). */
    public async forgetExternal(id: NoteId): Promise<void> {
        await this.removeIndexed(id);
        this.notes.removeEntry(id);
        this.pendingEmbeds.delete(id);
        this.invalidateTopology();
    }

    /**
     * A file was created or changed outside Synaipse (watcher). Returns
     * false when the content is already indexed — e.g. a parallel CLI
     * process (relink/compile) wrote it and recorded it in the cache.
     */
    public async absorbExternal(note: Note): Promise<boolean> {
        await this.notes.syncEntries();

        const cached = this.notes.getEntry(note.id);

        if (cached && cached.hash === note.hash) {
            return false;
        }

        await this.indexWritten(note);
        this.notes.recordEntry(note.id, note.hash, note.mtime);
        return true;
    }

    // --- access ------------------------------------------------------------

    public touchAccess(noteOrId: Note | NoteId): void {
        if (typeof noteOrId === 'string') {
            const note = this.notes.tryGet(noteOrId);

            if (note === undefined) {
                return;
            }

            this.notes.recordAccess(note.id, note.hash, note.mtime);
            return;
        }

        this.notes.recordAccess(noteOrId.id, noteOrId.hash, noteOrId.mtime);
    }

    public backlinks(id: NoteId): NoteId[] {
        this.touchAccess(id);
        return this.notes.backlinksOf(id);
    }

    // --- topology ----------------------------------------------------------

    public version(): number {
        return this.topologyGen;
    }

    /**
     * Topology might have changed (new/removed note or edited wikilinks).
     * Drop the memoised graph, link-key map, successors and search-time
     * adjacency; the next request rebuilds them lazily. Internal hooks
     * (the Atlas layout keeps serving the previous result while it
     * recomputes) run before the public listeners.
     */
    public invalidateTopology(): void {
        this.topologyGen++;
        for (const hook of this.invalidateHooks) hook();
        this.cachedGraph = null;
        this.cachedAdjacency = null;
        this.cachedLinkKeys = null;
        this.cachedSuccessors = null;

        for (const listener of this.topologyListeners) {
            try {
                listener(this.topologyGen);
            } catch (error) {
                log.warn('topology listener failed', {error});
            }
        }
    }

    public onInvalidate(hook: () => void): void {
        this.invalidateHooks.push(hook);
    }

    public onTopologyChange(listener: (version: number) => void): () => void {
        this.topologyListeners.add(listener);
        return () => {
            this.topologyListeners.delete(listener);
        };
    }

    /** Cached wikilink-target → note-id map (titles, then aliases; see buildLinkKeyMap). */
    public linkKeyMap(): Map<string, NoteId> {
        if (this.cachedLinkKeys === null) {
            this.cachedLinkKeys = buildLinkKeyMap(this.notes.list());
        }
        return this.cachedLinkKeys;
    }

    /** Superseded note → successor, from `supersedes` frontmatter and typed links (path, title or alias). */
    public successors(): Map<NoteId, NoteId> {
        if (this.cachedSuccessors === null) {
            const keys = this.linkKeyMap();
            this.cachedSuccessors = buildSuccessors(this.notes.list(), (target) =>
                this.notes.tryGet(target)?.id ?? this.notes.tryGet(`${target}.md`)?.id ?? keys.get(target));
        }
        return this.cachedSuccessors;
    }

    public knowledgeState(id: NoteId): KnowledgeState | null {
        const note = this.notes.tryGet(id);
        return note === undefined ? null : knowledgeStateOf(note, this.successors(), Date.now());
    }

    public unresolvedWikilinks(note: Pick<Note, 'wikilinks'>): string[] {
        const keys = this.linkKeyMap();
        return [...new Set(note.wikilinks)].filter((target) => !keys.has(target));
    }

    public adjacency(): AdjacencyMap {
        if (this.cachedAdjacency !== null) return this.cachedAdjacency;

        const notes = this.notes.list();
        const keyToId = this.linkKeyMap();
        this.cachedAdjacency = buildAdjacency(notes, (key) => keyToId.get(key));
        return this.cachedAdjacency;
    }

    public graph(): Graph {
        if (this.cachedGraph !== null) return this.cachedGraph;

        const notes = this.notes.list();
        const keyToId = this.linkKeyMap();

        const built: Graph = {
            nodes: notes.map((n) => ({id: n.id, title: n.title, tags: n.tags})),
            edges: notes.flatMap((n) =>
                n.wikilinks
                    .map((link) => keyToId.get(link))
                    .filter((target): target is NoteId => Boolean(target))
                    .map((target) => ({from: n.id, to: target, kind: 'wikilink' as const}))
            )
        };

        this.cachedGraph = built;
        return built;
    }
}
