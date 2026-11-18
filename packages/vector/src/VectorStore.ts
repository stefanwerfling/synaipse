import type {Chunk, NoteId, SearchHit} from '@synaipse/core';

/**
 * Storage port for chunk vectors. `QdrantStore` is the production
 * implementation; tests (and future embedded stores like LanceDB) plug in
 * behind the same interface so `VectorIndex` never depends on Qdrant.
 */
export interface VectorStore {
    ensureCollection(): Promise<void>;
    /** Insert-or-replace chunk vectors. Point ids are derived from `chunk.id`, so re-upserting a chunk overwrites it in place. */
    upsert(chunks: Chunk[], vectors: number[][]): Promise<void>;
    deleteByNote(noteId: NoteId): Promise<void>;
    deleteByNotes(noteIds: NoteId[]): Promise<void>;
    /**
     * Drop chunks left over from a longer previous version of a note:
     * for every `[noteId, keep]`, delete the note's chunks with
     * `index >= keep`. `keep = 0` removes all chunks of that note.
     */
    deleteStaleChunks(keep: ReadonlyMap<NoteId, number>): Promise<void>;
    search(vector: number[], limit: number): Promise<SearchHit[]>;
}
