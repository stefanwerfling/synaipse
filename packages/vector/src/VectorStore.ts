import type {Chunk, NoteId, SearchHit, SearchScope} from '@synaipse/core';

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
    /**
     * Nearest notes, one hit per note. With `scope`, only notes inside it
     * (plan P4 / A4); a store that cannot filter must over-fetch and
     * apply `inScope` itself, so callers always get up to `limit` hits.
     */
    search(vector: number[], limit: number, scope?: SearchScope): Promise<SearchHit[]>;
    /**
     * Optional, for diff-embedding (plan P4 / A4): chunk ids and content
     * hashes currently stored for these notes. Chunks without a stored
     * hash are omitted.
     */
    chunkHashes?(noteIds: readonly NoteId[]): Promise<Map<string, string>>;
    /** Optional: stored vectors by chunk id, to move an unchanged chunk to a new index without re-embedding. */
    vectorsOf?(chunkIds: readonly string[]): Promise<Map<string, number[]>>;
    /**
     * Optional (plan P4 / A3): nearest chunks of OTHER notes for each
     * stored chunk, using its stored vector, so no embedding call is
     * needed. Chunk ids that are not stored are absent from the result.
     * With a scope, only hits inside it count toward `limit`.
     */
    similarToChunks?(chunkIds: readonly string[], limit: number, scope?: SearchScope): Promise<Map<string, SearchHit[]>>;
}
