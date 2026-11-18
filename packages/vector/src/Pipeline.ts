import {createHash} from 'node:crypto';
import type {Note, NoteId, SearchHit, SearchScope} from '@synaipse/core';
import type {Embedder} from './Embedder.js';
import type {VectorStore} from './VectorStore.js';
import {chunkNote, CHUNK_DEFAULTS, ChunkOptions} from './Chunker.js';
import type {Chunk} from '@synaipse/core';

export interface VectorIndexOptions {
    embedder: Embedder;
    store: VectorStore;
    chunkOptions?: ChunkOptions;
    batchSize?: number;
    maxBatchChars?: number;
    onBatch?: (info: BatchInfo) => void;
    onOversize?: (chunk: Chunk) => void;
    /**
     * Embedder identity mixed into every chunk hash, so a model switch
     * never reuses vectors from the old model.
     */
    fingerprint?: string;
    /** Size of the in-memory query-embedding LRU (0 disables). */
    queryCacheSize?: number;
}

export interface BatchInfo {
    batch: number;
    batches: number;
    chunks: number;
    chars: number;
}

export interface IndexBatchResult {
    notes: number;
    chunks: number;
    batches: number;
    /** Chunks sent to the embedder. */
    embedded: number;
    /** Chunks whose stored vector was still valid (same hash). */
    reused: number;
}

/**
 * Small LRU for query embeddings: repeated searches (UI typing, MCP
 * agents re-asking) skip the embedder round trip.
 */
export class QueryEmbeddingCache {
    private readonly entries = new Map<string, number[]>();

    public constructor(private readonly capacity: number) {
    }

    public get(text: string): number[] | undefined {
        const hit = this.entries.get(text);

        if (hit !== undefined) {
            this.entries.delete(text);
            this.entries.set(text, hit);
        }

        return hit;
    }

    public set(text: string, vector: number[]): void {
        if (this.capacity <= 0) return;
        this.entries.delete(text);
        this.entries.set(text, vector);

        while (this.entries.size > this.capacity) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }

    public get size(): number {
        return this.entries.size;
    }
}

export const chunkHash = (fingerprint: string, text: string): string =>
    createHash('sha1').update(fingerprint).update('\0').update(text).digest('hex');

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_MAX_BATCH_CHARS = 200_000;

export const partitionChunks = (
    chunks: Chunk[],
    maxCount: number,
    maxChars: number
): Chunk[][] => {
    const partitions: Chunk[][] = [];
    let current: Chunk[] = [];
    let chars = 0;

    for (const chunk of chunks) {
        const len = chunk.text.length;

        if (current.length > 0 && (current.length >= maxCount || chars + len > maxChars)) {
            partitions.push(current);
            current = [];
            chars = 0;
        }

        current.push(chunk);
        chars += len;
    }

    if (current.length > 0) {
        partitions.push(current);
    }

    return partitions;
};

export class VectorIndex {
    private readonly embedder: Embedder;
    private readonly store: VectorStore;
    private readonly chunkOptions: ChunkOptions;
    private readonly batchSize: number;
    private readonly maxBatchChars: number;
    private readonly onBatch: ((info: BatchInfo) => void) | undefined;
    private readonly onOversize: ((chunk: Chunk) => void) | undefined;
    private readonly fingerprint: string;
    private readonly queryCache: QueryEmbeddingCache;

    public constructor(opts: VectorIndexOptions) {
        this.embedder = opts.embedder;
        this.store = opts.store;
        this.chunkOptions = opts.chunkOptions ?? CHUNK_DEFAULTS;
        this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
        this.maxBatchChars = opts.maxBatchChars ?? DEFAULT_MAX_BATCH_CHARS;
        this.onBatch = opts.onBatch;
        this.onOversize = opts.onOversize;
        this.fingerprint = opts.fingerprint ?? `dim:${opts.embedder.dimension}`;
        this.queryCache = new QueryEmbeddingCache(opts.queryCacheSize ?? 256);
    }

    public async indexNote(note: Note): Promise<void> {
        await this.indexNotes([note]);
    }

    public async indexNotes(notes: Note[]): Promise<IndexBatchResult> {
        if (notes.length === 0) {
            return {notes: 0, chunks: 0, batches: 0, embedded: 0, reused: 0};
        }

        // Upsert-then-trim instead of delete-then-upsert: point ids are
        // derived from `noteId::index`, so upserting overwrites existing
        // chunks in place and only the tail of a note that got shorter
        // has to go. If embedding fails half-way the note keeps its old
        // vectors instead of ending up with none (the caller does not
        // mark it embedded, so it is retried later).
        const keep = new Map<NoteId, number>();
        const allChunks: Chunk[] = [];

        for (const n of notes) {
            const chunks = chunkNote(n, this.chunkOptions);
            keep.set(n.id, chunks.length);
            for (const c of chunks) {
                allChunks.push({...c, hash: chunkHash(this.fingerprint, c.text)});
            }
        }

        if (allChunks.length === 0) {
            await this.store.deleteStaleChunks(keep);
            return {notes: notes.length, chunks: 0, batches: 0, embedded: 0, reused: 0};
        }

        const {toEmbed, moved} = await this.diffAgainstStore(notes.map((n) => n.id), allChunks);

        if (this.onOversize) {
            for (const chunk of toEmbed) {
                if (chunk.text.length > this.maxBatchChars) {
                    this.onOversize(chunk);
                }
            }
        }

        // Unchanged text at a new position (e.g. a paragraph inserted
        // above): copy the stored vector under the new chunk id.
        if (moved.chunks.length > 0) {
            await this.store.upsert(moved.chunks, moved.vectors);
        }

        const partitions = partitionChunks(toEmbed, this.batchSize, this.maxBatchChars);

        for (let i = 0; i < partitions.length; i += 1) {
            const slice = partitions[i]!;
            const vectors = await this.embedder.embed(slice.map((c) => c.text), 'document');
            await this.store.upsert(slice, vectors);

            this.onBatch?.({
                batch: i + 1,
                batches: partitions.length,
                chunks: slice.length,
                chars: slice.reduce((sum, c) => sum + c.text.length, 0)
            });
        }

        await this.store.deleteStaleChunks(keep);

        return {
            notes: notes.length,
            chunks: allChunks.length,
            batches: partitions.length,
            embedded: toEmbed.length,
            reused: allChunks.length - toEmbed.length
        };
    }

    /**
     * Diff-embedding (plan P4 / A4): chunks whose hash is already stored
     * under the same id are skipped; chunks whose hash is stored under a
     * different id of the same note reuse that vector. Stores without the
     * optional methods (or a failing lookup) embed everything, as before.
     */
    private async diffAgainstStore(
        noteIds: NoteId[],
        chunks: Chunk[]
    ): Promise<{toEmbed: Chunk[]; moved: {chunks: Chunk[]; vectors: number[][]}}> {
        const none = {toEmbed: chunks, moved: {chunks: [], vectors: []}};

        if (this.store.chunkHashes === undefined) {
            return none;
        }

        let stored: Map<string, string>;
        try {
            stored = await this.store.chunkHashes(noteIds);
        } catch {
            return none;
        }

        if (stored.size === 0) {
            return none;
        }

        // hash -> some stored chunk id carrying it, per note
        const byHash = new Map<string, string>();
        for (const [chunkId, hash] of stored) {
            const noteId = chunkId.slice(0, chunkId.lastIndexOf('::'));
            byHash.set(`${noteId}\0${hash}`, chunkId);
        }

        const toEmbed: Chunk[] = [];
        const movable: Array<{chunk: Chunk; from: string}> = [];

        for (const chunk of chunks) {
            if (stored.get(chunk.id) === chunk.hash) continue;

            const from = byHash.get(`${chunk.noteId}\0${chunk.hash}`);
            if (from !== undefined && this.store.vectorsOf !== undefined) {
                movable.push({chunk, from});
            } else {
                toEmbed.push(chunk);
            }
        }

        const moved = {chunks: [] as Chunk[], vectors: [] as number[][]};

        if (movable.length > 0 && this.store.vectorsOf !== undefined) {
            let vectors = new Map<string, number[]>();
            try {
                vectors = await this.store.vectorsOf([...new Set(movable.map((m) => m.from))]);
            } catch {
                // fall through: everything without a vector gets embedded
            }

            for (const m of movable) {
                const vector = vectors.get(m.from);
                if (vector === undefined) {
                    toEmbed.push(m.chunk);
                } else {
                    moved.chunks.push(m.chunk);
                    moved.vectors.push(vector);
                }
            }
        }

        return {toEmbed, moved};
    }

    public async deleteNote(noteId: NoteId): Promise<void> {
        await this.store.deleteByNote(noteId);
    }

    public async deleteNotes(noteIds: NoteId[]): Promise<void> {
        await this.store.deleteByNotes(noteIds);
    }

    public async semanticSearch(query: string, limit: number, scope?: SearchScope): Promise<SearchHit[]> {
        return this.store.search(await this.embedQuery(query), limit, scope);
    }

    /**
     * Notes similar to each given note, from the note's stored first
     * chunk; no embedding call. Notes without a stored first chunk (or a
     * store without support) are absent; callers embed those themselves.
     */
    public async similarToNotes(noteIds: readonly NoteId[], limit: number): Promise<Map<NoteId, SearchHit[]>> {
        const out = new Map<NoteId, SearchHit[]>();

        if (this.store.similarToChunks === undefined || noteIds.length === 0) {
            return out;
        }

        const byChunk = await this.store.similarToChunks(noteIds.map((id) => `${id}::0`), limit);

        for (const [chunkId, hits] of byChunk) {
            out.set(chunkId.slice(0, chunkId.lastIndexOf('::')), hits);
        }

        return out;
    }

    /** Query embedding through the LRU cache. */
    public async embedQuery(query: string): Promise<number[]> {
        const cached = this.queryCache.get(query);

        if (cached !== undefined) {
            return cached;
        }

        const vector = await this.embedder.embedOne(query, 'query');
        this.queryCache.set(query, vector);
        return vector;
    }
}