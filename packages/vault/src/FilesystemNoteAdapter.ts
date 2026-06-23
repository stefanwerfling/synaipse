import type {Note, NoteAdapter, NoteEntry, NoteId, NoteWriteContext, NoteWriteInput} from '@synaipse/core';
import {HashCache} from './Cache.js';
import {Vault} from './Vault.js';

/**
 * Filesystem-backed implementation of NoteAdapter. Wraps the in-memory
 * Vault (markdown files + ngit history) and the HashCache (sidecar
 * JSON tracking per-note hash and access journal) behind one port so
 * the Service can stay storage-agnostic. The MariaDB equivalent lives
 * in @synaipse/server-storage (planned) and uses SQL columns instead
 * of the sidecar.
 *
 * Write/delete auto-update the entry index + flush, so call sites
 * that only edit notes don't need to think about it. Bulk operations
 * (the embedding batch) use recordEntry + explicit flushEntries to
 * keep disk writes off the per-note hot path.
 */
export class FilesystemNoteAdapter implements NoteAdapter {
    public constructor(
        private readonly vault: Vault,
        private readonly cache: HashCache
    ) {}

    public async load(): Promise<void> {
        await Promise.all([this.vault.load(), this.cache.load()]);
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

    public async write(input: NoteWriteInput, ctx: NoteWriteContext = {}): Promise<Note> {
        const note = await this.vault.write(input, ctx);
        this.cache.set(note.id, {hash: note.hash, mtime: note.mtime});
        await this.cache.flush();
        return note;
    }

    public async delete(id: NoteId, ctx: NoteWriteContext = {}): Promise<void> {
        await this.vault.delete(id, ctx);
        this.cache.delete(id);
        await this.cache.flush();
    }

    public backlinksOf(id: NoteId): NoteId[] {
        return this.vault.backlinksOf(id);
    }

    public tags(): Map<string, NoteId[]> {
        return this.vault.tags();
    }

    public getEntry(id: NoteId): NoteEntry | undefined {
        return this.cache.get(id);
    }

    public entryIds(): NoteId[] {
        return this.cache.ids();
    }

    public recordEntry(id: NoteId, hash: string, mtime: number): void {
        this.cache.set(id, {hash, mtime});
    }

    public recordAccess(id: NoteId, hashSeed?: string, mtimeSeed?: number): void {
        if (hashSeed !== undefined && mtimeSeed !== undefined) {
            this.cache.touch(id, {hash: hashSeed, mtime: mtimeSeed});
            return;
        }
        this.cache.touch(id);
    }

    public removeEntry(id: NoteId): void {
        this.cache.delete(id);
    }

    public flushEntries(): Promise<void> {
        return this.cache.flush();
    }

    public syncEntries(): Promise<boolean> {
        return this.cache.reloadIfChanged();
    }
}