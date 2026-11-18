import {AsyncLocalStorage} from 'node:async_hooks';
import type {Note, NoteId, WriteBatchChanges} from '@synaipse/core';

/**
 * Collects the side effects of many note writes so they run once at the
 * end instead of once per note (plan P1 / A1): one ngit commit, grouped
 * embedding, one cache flush. Bound to the async context of the batch
 * callback via {@link writeBatchStorage}, so writes from other requests
 * running concurrently (an MCP write during a crawl) are NOT swallowed.
 */
export class WriteBatch implements WriteBatchChanges {
    public readonly adds = new Set<string>();
    public readonly deletes = new Set<string>();
    /** Notes whose embedding was deferred, latest version per id. */
    public readonly embeds = new Map<NoteId, Note>();

    public recordWrite(relPath: string): void {
        this.deletes.delete(relPath);
        this.adds.add(relPath);
    }

    public recordDelete(relPath: string): void {
        this.adds.delete(relPath);
        this.deletes.add(relPath);
        this.embeds.delete(relPath);
    }

    public deferEmbed(note: Note): void {
        this.embeds.set(note.id, note);
    }

    public get size(): number {
        return this.adds.size + this.deletes.size;
    }
}

export const writeBatchStorage = new AsyncLocalStorage<WriteBatch>();

/** The batch the current async context writes into, if any. */
export const currentWriteBatch = (): WriteBatch | undefined => writeBatchStorage.getStore();

/**
 * Run `fn` inside a fresh write batch and hand the collected changes to
 * `finish` afterwards — also when `fn` throws, because its writes are
 * already on disk. Nested calls join the outer batch (finish runs once).
 */
export const runWriteBatch = async <T>(fn: () => Promise<T>, finish: (batch: WriteBatch) => Promise<void>): Promise<T> => {
    if (currentWriteBatch() !== undefined) {
        return fn();
    }

    const batch = new WriteBatch();
    try {
        return await writeBatchStorage.run(batch, fn);
    } finally {
        await finish(batch);
    }
};
