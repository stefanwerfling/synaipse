import {
    createLogger,
    type ExternalNoteChange,
    type Note,
    type NoteAdapter,
    type NoteEntry,
    type NoteId,
    type NoteWriteContext,
    type NoteWriteInput,
    type WriteBatchChanges
} from '@synaipse/core';
import {RepoHistory, toMarkdownFile} from './RepoHistory.js';
import {currentWriteBatch} from './WriteBatch.js';

const log = createLogger('versioned-notes');

/**
 * Adds history to a note store that has none of its own (server mode,
 * plan A6): every write and delete becomes an ngit commit in a
 * {@link RepoHistory}; inside a write batch the paths are collected and
 * committed once in commitBatch(), as the filesystem vault does. Reads and
 * the access journal go straight to the wrapped adapter.
 *
 * A failed commit is logged, not thrown: the note is saved, only its
 * history entry is missing (same rule as local mode).
 */
export class VersionedNoteAdapter implements NoteAdapter {
    public readonly onExternalChange?: (listener: (changes: readonly ExternalNoteChange[]) => void) => () => void;
    public readonly resolveLink?: (key: string) => NoteId | undefined;

    public constructor(
        private readonly inner: NoteAdapter,
        private readonly history: RepoHistory
    ) {
        if (inner.onExternalChange !== undefined) {
            this.onExternalChange = inner.onExternalChange.bind(inner);
        }
        // Only when the inner adapter has one: otherwise the service falls back to its own map.
        if (inner.resolveLink !== undefined) {
            this.resolveLink = inner.resolveLink.bind(inner);
        }
    }

    public async write(input: NoteWriteInput, ctx: NoteWriteContext = {}): Promise<Note> {
        const note = await this.inner.write(input, ctx);
        const batch = currentWriteBatch();
        if (batch !== undefined) {
            batch.recordWrite(note.id);
        } else {
            await this.commit({adds: [note], deletes: []}, ctx.message ?? `synaipse: write ${note.id}`, ctx);
        }
        return note;
    }

    public async delete(id: NoteId, ctx: NoteWriteContext = {}): Promise<void> {
        await this.inner.delete(id, ctx);
        const batch = currentWriteBatch();
        if (batch !== undefined) {
            batch.recordDelete(id);
        } else {
            await this.commit({adds: [], deletes: [id]}, ctx.message ?? `synaipse: delete ${id}`, ctx);
        }
    }

    /** One commit for the whole batch; a path written and then deleted again counts as deleted. */
    public async commitBatch(changes: WriteBatchChanges, ctx: NoteWriteContext = {}): Promise<void> {
        const adds: Note[] = [];
        const deletes = [...changes.deletes];
        for (const id of changes.adds) {
            const note = this.inner.tryGet(id);
            if (note === undefined) deletes.push(id);
            else adds.push(note);
        }
        if (adds.length === 0 && deletes.length === 0) return;
        await this.commit({adds, deletes}, ctx.message ?? `synaipse: batch (${adds.length} written, ${deletes.length} deleted)`, ctx);
    }

    private async commit(change: {adds: readonly Note[]; deletes: readonly string[]}, message: string, ctx: NoteWriteContext): Promise<void> {
        try {
            await this.history.commit({
                adds: change.adds.map((n) => ({path: n.path, content: toMarkdownFile(n.content, n.frontmatter)})),
                deletes: change.deletes,
                message,
                ...(ctx.author !== undefined ? {author: ctx.author} : {})
            });
        } catch (error) {
            log.error('history commit failed', {adds: change.adds.length, deletes: change.deletes.length, error});
        }
    }

    // ─── Delegated as is ───

    public load(): Promise<void> {
        return this.inner.load();
    }

    public isLoaded(): boolean {
        return this.inner.isLoaded();
    }

    public list(): Note[] {
        return this.inner.list();
    }

    public get(id: NoteId): Note {
        return this.inner.get(id);
    }

    public tryGet(id: NoteId): Note | undefined {
        return this.inner.tryGet(id);
    }

    public read(id: NoteId): Promise<Note> {
        return this.inner.read(id);
    }

    public closeLocal(): void {
        this.inner.closeLocal?.();
    }

    public backlinksOf(id: NoteId): NoteId[] {
        return this.inner.backlinksOf(id);
    }

    public tags(): Map<string, NoteId[]> {
        return this.inner.tags();
    }

    public getEntry(id: NoteId): NoteEntry | undefined {
        return this.inner.getEntry(id);
    }

    public entryIds(): NoteId[] {
        return this.inner.entryIds();
    }

    public recordEntry(id: NoteId, hash: string, mtime: number): void {
        this.inner.recordEntry(id, hash, mtime);
    }

    public recordEmbedded(id: NoteId, hash: string, model: string): void {
        this.inner.recordEmbedded(id, hash, model);
    }

    public recordAccess(id: NoteId, hashSeed?: string, mtimeSeed?: number): void {
        this.inner.recordAccess(id, hashSeed, mtimeSeed);
    }

    public recordReference(id: NoteId, hashSeed?: string, mtimeSeed?: number): void {
        this.inner.recordReference(id, hashSeed, mtimeSeed);
    }

    public removeEntry(id: NoteId): void {
        this.inner.removeEntry(id);
    }

    public flushEntries(): Promise<void> {
        return this.inner.flushEntries();
    }

    public syncEntries(): Promise<boolean> {
        return this.inner.syncEntries();
    }
}

/**
 * Server-mode wiring: with a history directory the note store is wrapped
 * so every change is versioned there; without one, history stays off.
 */
export const withServerHistory = (
    notes: NoteAdapter,
    historyDir: string | undefined,
    author?: {name: string; email: string}
): {notes: NoteAdapter; history: RepoHistory | null} => {
    if (historyDir === undefined || historyDir.length === 0) {
        return {notes, history: null};
    }
    const history = new RepoHistory(historyDir, author);
    return {notes: new VersionedNoteAdapter(notes, history), history};
};
