import type {Note, NoteId, NoteWriteInput} from './Types.js';

export interface NoteWriteContext {
    message?: string;
    author?: {name: string; email: string};
}

/**
 * Per-note index entry tracked by the adapter: content hash for
 * change-detection (decides whether to re-embed) plus a runtime
 * access journal used by recency-biased ranking. Filesystem-backed
 * adapters persist this in a sidecar JSON; DB-backed adapters store
 * it as a column on the notes table plus a small access table.
 */
export interface NoteEntry {
    hash: string;
    mtime: number;
    accessCount?: number;
    lastAccessed?: number;
}

/**
 * Storage port for notes. Two implementations:
 * - FilesystemNoteAdapter (@synaipse/vault) — markdown files + ngit + sidecar HashCache
 * - MariaDBNoteAdapter (@synaipse/server-storage, planned) — DB-backed Hot-Tier
 *
 * See Memory/synaipse/decisions/2026-06-23-server-mode-architecture.md.
 */
export interface NoteAdapter {
    load(): Promise<void>;
    isLoaded(): boolean;
    list(): Note[];
    get(id: NoteId): Note;
    tryGet(id: NoteId): Note | undefined;
    read(id: NoteId): Promise<Note>;
    write(input: NoteWriteInput, ctx?: NoteWriteContext): Promise<Note>;
    delete(id: NoteId, ctx?: NoteWriteContext): Promise<void>;
    backlinksOf(id: NoteId): NoteId[];
    tags(): Map<string, NoteId[]>;

    /** Index-entry queries (hash + access journal). */
    getEntry(id: NoteId): NoteEntry | undefined;
    entryIds(): NoteId[];
    /** Record hash+mtime after successful embedding (used by the indexing batch). Sync; pair with flushEntries() for durability. */
    recordEntry(id: NoteId, hash: string, mtime: number): void;
    /** Bump accessCount/lastAccessed; optionally seed the entry if it does not yet exist. */
    recordAccess(id: NoteId, hashSeed?: string, mtimeSeed?: number): void;
    /** Drop an entry (used when a note is removed externally). */
    removeEntry(id: NoteId): void;
    /** Force a durable write of pending entry changes. */
    flushEntries(): Promise<void>;
    /** Re-read entries from disk if a parallel process touched them. Returns true if anything changed. */
    syncEntries(): Promise<boolean>;
}