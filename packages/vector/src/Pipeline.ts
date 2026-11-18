import type {Note, NoteId, SearchHit} from '@synaipse/core';
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
}

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

    public constructor(opts: VectorIndexOptions) {
        this.embedder = opts.embedder;
        this.store = opts.store;
        this.chunkOptions = opts.chunkOptions ?? CHUNK_DEFAULTS;
        this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
        this.maxBatchChars = opts.maxBatchChars ?? DEFAULT_MAX_BATCH_CHARS;
        this.onBatch = opts.onBatch;
        this.onOversize = opts.onOversize;
    }

    public async indexNote(note: Note): Promise<void> {
        await this.indexNotes([note]);
    }

    public async indexNotes(notes: Note[]): Promise<IndexBatchResult> {
        if (notes.length === 0) {
            return {notes: 0, chunks: 0, batches: 0};
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
            allChunks.push(...chunks);
        }

        if (allChunks.length === 0) {
            await this.store.deleteStaleChunks(keep);
            return {notes: notes.length, chunks: 0, batches: 0};
        }

        if (this.onOversize) {
            for (const chunk of allChunks) {
                if (chunk.text.length > this.maxBatchChars) {
                    this.onOversize(chunk);
                }
            }
        }

        const partitions = partitionChunks(allChunks, this.batchSize, this.maxBatchChars);

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

        return {notes: notes.length, chunks: allChunks.length, batches: partitions.length};
    }

    public async deleteNote(noteId: NoteId): Promise<void> {
        await this.store.deleteByNote(noteId);
    }

    public async deleteNotes(noteIds: NoteId[]): Promise<void> {
        await this.store.deleteByNotes(noteIds);
    }

    public async semanticSearch(query: string, limit: number): Promise<SearchHit[]> {
        const vector = await this.embedder.embedOne(query, 'query');

        return this.store.search(vector, limit);
    }
}