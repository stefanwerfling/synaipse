import type {Note, NoteAdapter, NoteId, NoteWriteContext, NoteWriteInput} from '@synaipse/core';
import {Vault} from './Vault.js';

/**
 * Thin adapter wrapping the existing in-memory Vault. Lets call sites
 * depend on NoteAdapter instead of the concrete Vault class so a
 * second implementation (MariaDBNoteAdapter) can slot in without
 * touching the Service.
 *
 * The HashCache currently lives outside of Vault as a Service-level
 * concern; integration with this adapter is the next step in Phase 1
 * (see ADR Server-Mode Architecture).
 */
export class FilesystemNoteAdapter implements NoteAdapter {
    public constructor(private readonly vault: Vault) {}

    public load(): Promise<void> {
        return this.vault.load();
    }

    public isLoaded(): boolean {
        return this.vault.isLoaded();
    }

    public list(): Note[] {
        return this.vault.list();
    }

    public get(id: NoteId): Note {
        return this.vault.get(id);
    }

    public tryGet(id: NoteId): Note | undefined {
        return this.vault.tryGet(id);
    }

    public read(id: NoteId): Promise<Note> {
        return this.vault.read(id);
    }

    public write(input: NoteWriteInput, ctx: NoteWriteContext = {}): Promise<Note> {
        return this.vault.write(input, ctx);
    }

    public delete(id: NoteId, ctx: NoteWriteContext = {}): Promise<void> {
        return this.vault.delete(id, ctx);
    }

    public backlinksOf(id: NoteId): NoteId[] {
        return this.vault.backlinksOf(id);
    }

    public tags(): Map<string, NoteId[]> {
        return this.vault.tags();
    }
}