import {existsSync} from 'node:fs';
import {rename} from 'node:fs/promises';
import type {StatementSync} from 'node:sqlite';
import {HashCache, type CacheEntry, type TouchSeed} from './Cache.js';
import {StateDb} from './StateDb.js';

/** `embeddedHash` of an entry whose content was never embedded. */
const NOT_EMBEDDED = '';

/**
 * What FilesystemNoteAdapter needs from its per-note entry cache. Both the
 * SQLite {@link EntryStore} and the legacy JSON {@link HashCache} satisfy it.
 */
export interface EntryCache {
    load(): Promise<void>;
    reloadIfChanged(): Promise<boolean>;
    get(id: string): CacheEntry | undefined;
    has(id: string): boolean;
    ids(): string[];
    size(): number;
    set(id: string, entry: CacheEntry): void;
    setEmbedded(id: string, hash: string, model: string): void;
    touch(id: string, seed?: TouchSeed, now?: number): void;
    touchReference(id: string, seed?: TouchSeed, now?: number): void;
    delete(id: string): void;
    flush(): Promise<void>;
    close?(): void;
}

interface EntryRow {
    id: string;
    hash: string;
    mtime: number;
    embedded_hash: string;
    embed_model: string | null;
    access_count: number | null;
    last_accessed: number | null;
    referenced_count: number | null;
    last_referenced: number | null;
}

const fromRow = (row: EntryRow): CacheEntry => ({
    hash: row.hash,
    mtime: row.mtime,
    embeddedHash: row.embedded_hash,
    ...(row.embed_model !== null ? {embedModel: row.embed_model} : {}),
    ...(row.access_count !== null ? {accessCount: row.access_count} : {}),
    ...(row.last_accessed !== null ? {lastAccessed: row.last_accessed} : {}),
    ...(row.referenced_count !== null ? {referencedCount: row.referenced_count} : {}),
    ...(row.last_referenced !== null ? {lastReferenced: row.last_referenced} : {})
});

export interface EntryStoreOptions {
    /** Old JSON sidecar to import on first start (then renamed to `*.migrated-<ts>`). */
    legacyJsonPath?: string;
    /** Debounce for writing changed rows (default 500 ms). */
    debounceMs?: number;
}

/**
 * Per-note index entries in the vault's SQLite state DB (plan P1 / A2).
 *
 * Same semantics as the JSON {@link HashCache} — reads come from an
 * in-memory map, so every getter stays synchronous — but persistence
 * writes only the rows that changed, in one transaction per debounce
 * window, instead of rewriting the whole file on every write and every
 * access-count bump.
 */
export class EntryStore implements EntryCache {
    private readonly data = new Map<string, CacheEntry>();
    /** ids changed since the last flush; a missing map entry means "deleted". */
    private readonly dirty = new Set<string>();
    private flushTimer: NodeJS.Timeout | null = null;
    private state: StateDb | null = null;
    private knownVersion = -1;
    private upsertStmt: StatementSync | null = null;
    private deleteStmt: StatementSync | null = null;
    private readonly debounceMs: number;

    public constructor(private readonly file: string, private readonly opts: EntryStoreOptions = {}) {
        this.debounceMs = opts.debounceMs ?? 500;
    }

    private db(): StateDb {
        if (this.state === null) {
            this.state = new StateDb(this.file);
            this.upsertStmt = this.state.db.prepare(
                `INSERT INTO entries (id, hash, mtime, embedded_hash, embed_model, access_count, last_accessed, referenced_count, last_referenced)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, mtime = excluded.mtime,
                    embedded_hash = excluded.embedded_hash, embed_model = excluded.embed_model,
                    access_count = excluded.access_count, last_accessed = excluded.last_accessed,
                    referenced_count = excluded.referenced_count, last_referenced = excluded.last_referenced`
            );
            this.deleteStmt = this.state.db.prepare('DELETE FROM entries WHERE id = ?');
        }
        return this.state;
    }

    public async load(): Promise<void> {
        const state = this.db();
        await this.importLegacyJson(state);
        this.readAll(state);
    }

    private readAll(state: StateDb): void {
        this.data.clear();
        for (const row of state.db.prepare('SELECT * FROM entries').all() as unknown as EntryRow[]) {
            this.data.set(row.id, fromRow(row));
        }
        this.knownVersion = state.dataVersion();
    }

    /**
     * First start after the upgrade: copy the JSON sidecar (including its
     * legacy-embedding adoption, see HashCache.load) into the empty table
     * and rename the file, so nothing is re-embedded and a rollback still
     * finds the original.
     */
    private async importLegacyJson(state: StateDb): Promise<void> {
        const legacy = this.opts.legacyJsonPath;
        if (legacy === undefined || !existsSync(legacy)) return;
        const count = (state.db.prepare('SELECT COUNT(*) AS n FROM entries').get() as {n: number}).n;
        if (count > 0) return;

        const json = new HashCache(legacy, 0);
        await json.load();
        state.transaction(() => {
            for (const id of json.ids()) this.writeRow(id, json.get(id)!);
        });
        const target = `${legacy}.migrated-${Date.now()}`;
        await rename(legacy, target).catch(() => undefined);
        process.stderr.write(`[synaipse] index cache migrated to ${this.file} (${json.size()} entries); old file kept as ${target}\n`);
    }

    public async reloadIfChanged(): Promise<boolean> {
        const state = this.db();
        if (state.dataVersion() === this.knownVersion) return false;
        // Persist our own pending changes first so the reload can't drop them.
        await this.flush();
        this.readAll(state);
        return true;
    }

    public get(id: string): CacheEntry | undefined {
        return this.data.get(id);
    }

    public has(id: string): boolean {
        return this.data.has(id);
    }

    public ids(): string[] {
        return [...this.data.keys()];
    }

    public size(): number {
        return this.data.size;
    }

    public set(id: string, entry: CacheEntry): void {
        const prev = this.data.get(id);
        if (prev && prev.hash === entry.hash && prev.mtime === entry.mtime) return;

        const embedModel = entry.embedModel ?? prev?.embedModel;
        this.data.set(id, {
            ...entry,
            ...(prev?.accessCount !== undefined ? {accessCount: prev.accessCount} : {}),
            ...(prev?.lastAccessed !== undefined ? {lastAccessed: prev.lastAccessed} : {}),
            ...(prev?.referencedCount !== undefined ? {referencedCount: prev.referencedCount} : {}),
            ...(prev?.lastReferenced !== undefined ? {lastReferenced: prev.lastReferenced} : {}),
            embeddedHash: entry.embeddedHash ?? prev?.embeddedHash ?? NOT_EMBEDDED,
            ...(embedModel !== undefined ? {embedModel} : {})
        });
        this.schedule(id);
    }

    public setEmbedded(id: string, hash: string, model: string): void {
        const existing = this.data.get(id);
        if (existing === undefined) {
            this.data.set(id, {hash, mtime: 0, embeddedHash: hash, embedModel: model});
        } else {
            if (existing.embeddedHash === hash && existing.embedModel === model) return;
            existing.embeddedHash = hash;
            existing.embedModel = model;
        }
        this.schedule(id);
    }

    public touch(id: string, seed?: TouchSeed, now: number = Date.now()): void {
        const existing = this.data.get(id);
        if (existing) {
            existing.accessCount = (existing.accessCount ?? 0) + 1;
            existing.lastAccessed = now;
        } else if (seed) {
            this.data.set(id, {hash: seed.hash, mtime: seed.mtime, accessCount: 1, lastAccessed: now, embeddedHash: NOT_EMBEDDED});
        } else {
            return;
        }
        this.schedule(id);
    }

    public touchReference(id: string, seed?: TouchSeed, now: number = Date.now()): void {
        const existing = this.data.get(id);
        if (existing) {
            existing.referencedCount = (existing.referencedCount ?? 0) + 1;
            existing.lastReferenced = now;
        } else if (seed) {
            this.data.set(id, {hash: seed.hash, mtime: seed.mtime, referencedCount: 1, lastReferenced: now, embeddedHash: NOT_EMBEDDED});
        } else {
            return;
        }
        this.schedule(id);
    }

    public delete(id: string): void {
        if (!this.data.delete(id)) return;
        this.schedule(id);
    }

    public async flush(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.dirty.size === 0) return;

        const state = this.db();
        const ids = [...this.dirty];
        this.dirty.clear();
        try {
            state.transaction(() => {
                for (const id of ids) {
                    const entry = this.data.get(id);
                    if (entry === undefined) this.deleteStmt!.run(id);
                    else this.writeRow(id, entry);
                }
            });
        } catch (error) {
            for (const id of ids) this.dirty.add(id);
            throw error;
        }
        // Our own commit doesn't bump data_version for this connection,
        // so knownVersion stays valid.
    }

    public close(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.state?.close();
        this.state = null;
    }

    private writeRow(id: string, e: CacheEntry): void {
        this.upsertStmt!.run(
            id, e.hash, e.mtime, e.embeddedHash ?? NOT_EMBEDDED, e.embedModel ?? null,
            e.accessCount ?? null, e.lastAccessed ?? null, e.referencedCount ?? null, e.lastReferenced ?? null
        );
    }

    private schedule(id: string): void {
        this.dirty.add(id);
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush().catch((error: unknown) => {
                process.stderr.write(`[synaipse] WARN state flush failed, retried on next change: ${String(error)}\n`);
            });
        }, this.debounceMs);
    }
}
