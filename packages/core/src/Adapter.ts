import type {Note, NoteId, NoteWriteInput} from './Types.js';

export interface NoteWriteContext {
    message?: string;
    author?: {name: string; email: string};
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
}