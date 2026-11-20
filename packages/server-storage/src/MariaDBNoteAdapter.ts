import {createHash} from 'node:crypto';
import type {Pool} from 'mariadb';
import {
    createLogger,
    extractTags,
    extractWikilinks,
    LinkIndex,
    type Frontmatter,
    type Note,
    type NoteAdapter,
    type NoteEntry,
    type NoteId,
    type NoteWriteContext,
    type NoteWriteInput
} from '@synaipse/core';
import type {ResolvedMariaDBConfig} from './Pool.js';

interface NoteRow {
    note_path: string;
    title: string;
    frontmatter: string | object;
    body: string;
    hash: string;
    mtime_ms: number;
    access_count: number;
    last_accessed: number | null;
    referenced_count: number;
    last_referenced: number | null;
    embedded_hash?: string | null;
    embed_model?: string | null;
}

const sha1 = (input: string): string => createHash('sha1').update(input).digest('hex');

const titleFor = (frontmatter: Frontmatter, notePath: string, body: string): string => {
    if (typeof frontmatter.title === 'string' && frontmatter.title.length > 0) {
        return frontmatter.title;
    }
    const heading = body.match(/^#\s+(.+)$/m);
    if (heading?.[1]) return heading[1].trim();
    const segments = notePath.split('/');
    const base = segments[segments.length - 1] ?? notePath;
    return base.replace(/\.md$/, '');
};

const parseFrontmatter = (raw: string | object): Frontmatter => {
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw) as Frontmatter;
        } catch {
            return {};
        }
    }
    return raw as Frontmatter;
};

const rowToNote = (row: NoteRow): Note => {
    const frontmatter = parseFrontmatter(row.frontmatter);
    return {
        id: row.note_path,
        path: row.note_path,
        title: row.title,
        content: row.body,
        frontmatter,
        tags: extractTags(row.body, frontmatter),
        wikilinks: extractWikilinks(row.body),
        backlinks: [],
        mtime: row.mtime_ms,
        hash: row.hash
    };
};

const log = createLogger('mariadb-notes');

/**
 * Pending journal changes for one note. Counters are deltas, not totals,
 * so several processes sharing a vault add up instead of overwriting each
 * other; timestamps only ever move forward (GREATEST).
 */
interface DirtyEntry {
    hash?: string;
    mtime?: number;
    accessDelta?: number;
    lastAccessed?: number;
    referencedDelta?: number;
    lastReferenced?: number;
    embeddedHash?: string;
    embedModel?: string;
}

/** Rows per multi-row UPDATE (keeps the statement well below max_allowed_packet). */
export const FLUSH_CHUNK = 500;

/** `newer` on top of `older`: latest values win, deltas add up. */
export const mergeDirty = (older: DirtyEntry, newer: DirtyEntry): DirtyEntry => {
    const out: DirtyEntry = {...older, ...newer};
    const access = (older.accessDelta ?? 0) + (newer.accessDelta ?? 0);
    const referenced = (older.referencedDelta ?? 0) + (newer.referencedDelta ?? 0);
    if (access > 0) out.accessDelta = access;
    if (referenced > 0) out.referencedDelta = referenced;
    return out;
};

/**
 * One UPDATE … JOIN over a derived table of all rows in `chunk`. An
 * UPDATE (not INSERT … ON DUPLICATE KEY) so a note deleted in the
 * meantime is not resurrected as an empty row. The first SELECT casts
 * every column, which fixes the derived table's column types even when
 * the first row's values are NULL.
 */
export const buildFlushStatement = (vaultId: number, chunk: ReadonlyArray<readonly [string, DirtyEntry]>): {sql: string; params: unknown[]} => {
    const first = 'SELECT CAST(? AS CHAR(1024)) AS p, CAST(? AS CHAR(40)) AS h, CAST(? AS SIGNED) AS m, '
        + 'CAST(? AS SIGNED) AS ad, CAST(? AS SIGNED) AS la, CAST(? AS SIGNED) AS rd, CAST(? AS SIGNED) AS lr, '
        + 'CAST(? AS CHAR(64)) AS eh, CAST(? AS CHAR(255)) AS em';
    const rest = ' UNION ALL SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?';
    const params: unknown[] = [];
    for (const [id, d] of chunk) {
        params.push(
            id,
            d.hash ?? null,
            d.mtime ?? null,
            d.accessDelta ?? null,
            d.lastAccessed ?? null,
            d.referencedDelta ?? null,
            d.lastReferenced ?? null,
            d.embeddedHash ?? null,
            d.embedModel ?? null
        );
    }
    params.push(vaultId);
    const sql = `UPDATE notes n JOIN (${first}${rest.repeat(chunk.length - 1)}) d
        ON n.vault_id = ? AND n.note_path = d.p
        SET n.hash = COALESCE(d.h, n.hash),
            n.mtime_ms = COALESCE(d.m, n.mtime_ms),
            n.access_count = n.access_count + COALESCE(d.ad, 0),
            n.last_accessed = CASE WHEN d.la IS NULL THEN n.last_accessed ELSE GREATEST(COALESCE(n.last_accessed, 0), d.la) END,
            n.referenced_count = n.referenced_count + COALESCE(d.rd, 0),
            n.last_referenced = CASE WHEN d.lr IS NULL THEN n.last_referenced ELSE GREATEST(COALESCE(n.last_referenced, 0), d.lr) END,
            n.embedded_hash = COALESCE(d.eh, n.embedded_hash),
            n.embed_model = COALESCE(d.em, n.embed_model)`;
    return {sql, params};
};

/**
 * MariaDB-backed NoteAdapter. The Service treats this identically to
 * FilesystemNoteAdapter — same port, same semantics. SoT is the `notes`
 * table; an in-memory snapshot is warmed at load() so the sync methods
 * (list/get/backlinksOf/tags/getEntry) keep the same signatures as the
 * filesystem port.
 *
 * Write/delete persist immediately. The access journal
 * (recordAccess/recordEntry/removeEntry) batches into in-memory dirt
 * and persists on flushEntries() to keep the per-search hot path off
 * the DB round-trip.
 *
 * Wikilink/tag extraction and backlink resolution come from
 * @synaipse/core (Markdown.ts, LinkIndex.ts) — the same primitives the
 * filesystem vault uses, so `[[Title]]`/`[[alias]]` resolve to the same
 * note id in both storage modes.
 */
export class MariaDBNoteAdapter implements NoteAdapter {
    private notes = new Map<NoteId, Note>();
    private entries = new Map<NoteId, NoteEntry>();
    private readonly links = new LinkIndex();
    private tagIndex = new Map<string, Set<NoteId>>();
    private dirtyEntries = new Map<NoteId, DirtyEntry>();
    private loaded = false;
    /** Serialises flushes: the timer and explicit flushEntries() calls never interleave. */
    private flushing: Promise<void> = Promise.resolve();
    private flushTimer: ReturnType<typeof setInterval> | null = null;

    public constructor(
        private readonly pool: Pool,
        private readonly cfg: ResolvedMariaDBConfig
    ) {}

    public async load(): Promise<void> {
        const rows = await this.pool.query<NoteRow[]>(
            'SELECT note_path, title, frontmatter, body, hash, mtime_ms, access_count, last_accessed, referenced_count, last_referenced, embedded_hash, embed_model FROM notes WHERE vault_id = ?',
            [this.cfg.vaultId]
        );

        this.notes.clear();
        this.entries.clear();
        this.links.clear();
        this.tagIndex.clear();
        this.dirtyEntries.clear();

        for (const row of rows) {
            const note = rowToNote(row);
            this.notes.set(note.id, note);
            this.entries.set(note.id, {
                hash: row.hash,
                mtime: row.mtime_ms,
                ...(row.access_count > 0 ? {accessCount: row.access_count} : {}),
                ...(row.last_accessed !== null ? {lastAccessed: row.last_accessed} : {}),
                ...(row.referenced_count > 0 ? {referencedCount: row.referenced_count} : {}),
                ...(row.last_referenced !== null ? {lastReferenced: row.last_referenced} : {}),
                ...(typeof row.embedded_hash === 'string' ? {embeddedHash: row.embedded_hash} : {}),
                ...(typeof row.embed_model === 'string' ? {embedModel: row.embed_model} : {})
            });
            for (const tag of note.tags) {
                let bucket = this.tagIndex.get(tag);
                if (!bucket) {
                    bucket = new Set();
                    this.tagIndex.set(tag, bucket);
                }
                bucket.add(note.id);
            }
            this.links.upsert(note);
        }

        this.loaded = true;
        this.startFlushTimer();
    }

    /**
     * Searches bump the access journal in memory; without a periodic
     * flush those counters only reached the DB at index time or on a
     * clean stop and were lost on a crash (plan A6).
     */
    private startFlushTimer(): void {
        if (this.flushTimer !== null || this.cfg.accessFlushMs <= 0) return;
        this.flushTimer = setInterval(() => {
            this.flushEntries().catch((error: unknown) => {
                log.warn('periodic access-journal flush failed; retried on the next tick', {error});
            });
        }, this.cfg.accessFlushMs);
        this.flushTimer.unref();
    }

    public closeLocal(): void {
        if (this.flushTimer !== null) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
    }

    public isLoaded(): boolean {
        return this.loaded;
    }

    public list(): Note[] {
        return [...this.notes.values()].map((n) => this.withBacklinks(n));
    }

    public get(id: NoteId): Note {
        const note = this.notes.get(id);
        if (note === undefined) {
            throw new Error(`Note not found: ${id}`);
        }
        return this.withBacklinks(note);
    }

    public tryGet(id: NoteId): Note | undefined {
        const note = this.notes.get(id);
        return note === undefined ? undefined : this.withBacklinks(note);
    }

    public async read(id: NoteId): Promise<Note> {
        const rows = await this.pool.query<NoteRow[]>(
            'SELECT note_path, title, frontmatter, body, hash, mtime_ms, access_count, last_accessed FROM notes WHERE vault_id = ? AND note_path = ?',
            [this.cfg.vaultId, id]
        );
        const row = rows[0];
        if (row === undefined) {
            throw new Error(`Note not found: ${id}`);
        }
        const note = rowToNote(row);
        this.notes.set(note.id, note);
        return this.withBacklinks(note);
    }

    public async write(input: NoteWriteInput, _ctx: NoteWriteContext = {}): Promise<Note> {
        const frontmatter: Frontmatter = input.frontmatter ?? {};
        const title = titleFor(frontmatter, input.path, input.content);
        const hash = sha1(input.content);
        const mtime = Date.now();

        await this.pool.query(
            `INSERT INTO notes (vault_id, note_path, title, frontmatter, body, hash, mtime_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                 title = VALUES(title),
                 frontmatter = VALUES(frontmatter),
                 body = VALUES(body),
                 hash = VALUES(hash),
                 mtime_ms = VALUES(mtime_ms)`,
            [
                this.cfg.vaultId,
                input.path,
                title,
                JSON.stringify(frontmatter),
                input.content,
                hash,
                mtime
            ]
        );

        const note: Note = {
            id: input.path,
            path: input.path,
            title,
            content: input.content,
            frontmatter,
            tags: extractTags(input.content, frontmatter),
            wikilinks: extractWikilinks(input.content),
            backlinks: [],
            mtime,
            hash
        };

        this.indexNote(note);
        const prevEntry = this.entries.get(note.id);
        this.entries.set(note.id, {
            ...(prevEntry ?? {}),
            hash,
            mtime
        });
        return this.withBacklinks(note);
    }

    public async delete(id: NoteId, _ctx: NoteWriteContext = {}): Promise<void> {
        await this.pool.query(
            'DELETE FROM notes WHERE vault_id = ? AND note_path = ?',
            [this.cfg.vaultId, id]
        );
        this.unindexNote(id);
        this.entries.delete(id);
        this.dirtyEntries.delete(id);
    }

    public backlinksOf(id: NoteId): NoteId[] {
        return this.links.backlinksOf(id);
    }

    public tags(): Map<string, NoteId[]> {
        const out = new Map<string, NoteId[]>();
        for (const [tag, ids] of this.tagIndex) {
            out.set(tag, [...ids]);
        }
        return out;
    }

    public getEntry(id: NoteId): NoteEntry | undefined {
        return this.entries.get(id);
    }

    public entryIds(): NoteId[] {
        return [...this.entries.keys()];
    }

    public recordEntry(id: NoteId, hash: string, mtime: number): void {
        const prev = this.entries.get(id);
        if (prev && prev.hash === hash && prev.mtime === mtime) {
            return;
        }
        const merged: NoteEntry = {
            hash,
            mtime,
            ...(prev?.accessCount !== undefined ? {accessCount: prev.accessCount} : {}),
            ...(prev?.lastAccessed !== undefined ? {lastAccessed: prev.lastAccessed} : {}),
            ...(prev?.referencedCount !== undefined ? {referencedCount: prev.referencedCount} : {}),
            ...(prev?.lastReferenced !== undefined ? {lastReferenced: prev.lastReferenced} : {}),
            ...(prev?.embeddedHash !== undefined ? {embeddedHash: prev.embeddedHash} : {}),
            ...(prev?.embedModel !== undefined ? {embedModel: prev.embedModel} : {})
        };
        this.entries.set(id, merged);
        const dirty = this.dirtyEntries.get(id) ?? {};
        dirty.hash = hash;
        dirty.mtime = mtime;
        this.dirtyEntries.set(id, dirty);
    }

    public recordEmbedded(id: NoteId, hash: string, model: string): void {
        const existing = this.entries.get(id);
        if (existing === undefined) {
            // Embedded notes always exist in the table; without an entry
            // there is no row to UPDATE, so nothing to record.
            return;
        }
        if (existing.embeddedHash === hash && existing.embedModel === model) {
            return;
        }
        existing.embeddedHash = hash;
        existing.embedModel = model;
        const dirty = this.dirtyEntries.get(id) ?? {};
        dirty.embeddedHash = hash;
        dirty.embedModel = model;
        this.dirtyEntries.set(id, dirty);
    }

    public recordAccess(id: NoteId, hashSeed?: string, mtimeSeed?: number): void {
        const now = Date.now();
        const existing = this.entries.get(id);

        if (existing) {
            existing.accessCount = (existing.accessCount ?? 0) + 1;
            existing.lastAccessed = now;
            const dirty = this.dirtyEntries.get(id) ?? {};
            dirty.accessDelta = (dirty.accessDelta ?? 0) + 1;
            dirty.lastAccessed = now;
            this.dirtyEntries.set(id, dirty);
            return;
        }

        if (hashSeed === undefined || mtimeSeed === undefined) {
            return;
        }

        const seeded: NoteEntry = {
            hash: hashSeed,
            mtime: mtimeSeed,
            accessCount: 1,
            lastAccessed: now
        };
        this.entries.set(id, seeded);
        this.dirtyEntries.set(id, {
            hash: hashSeed,
            mtime: mtimeSeed,
            accessDelta: 1,
            lastAccessed: now
        });
    }

    public recordReference(id: NoteId, hashSeed?: string, mtimeSeed?: number): void {
        const now = Date.now();
        const existing = this.entries.get(id);

        if (existing) {
            existing.referencedCount = (existing.referencedCount ?? 0) + 1;
            existing.lastReferenced = now;
            const dirty = this.dirtyEntries.get(id) ?? {};
            dirty.referencedDelta = (dirty.referencedDelta ?? 0) + 1;
            dirty.lastReferenced = now;
            this.dirtyEntries.set(id, dirty);
            return;
        }

        if (hashSeed === undefined || mtimeSeed === undefined) {
            return;
        }

        const seeded: NoteEntry = {
            hash: hashSeed,
            mtime: mtimeSeed,
            referencedCount: 1,
            lastReferenced: now
        };
        this.entries.set(id, seeded);
        this.dirtyEntries.set(id, {
            hash: hashSeed,
            mtime: mtimeSeed,
            referencedDelta: 1,
            lastReferenced: now
        });
    }

    public removeEntry(id: NoteId): void {
        this.entries.delete(id);
        this.dirtyEntries.delete(id);
    }

    public flushEntries(): Promise<void> {
        const run = this.flushing.then(() => this.flushNow());
        // Keep the chain alive after a failure; the caller still sees the error.
        this.flushing = run.catch(() => undefined);
        return run;
    }

    /**
     * Writes all pending journal changes in multi-row UPDATEs of
     * {@link FLUSH_CHUNK} rows inside one transaction. Changes recorded
     * while the flush runs go to a fresh map; on failure the taken batch
     * is merged back so nothing is lost.
     */
    private async flushNow(): Promise<void> {
        if (this.dirtyEntries.size === 0) {
            return;
        }

        const batch = this.dirtyEntries;
        this.dirtyEntries = new Map();
        const rows = [...batch];

        const conn = await this.pool.getConnection();
        try {
            await conn.beginTransaction();
            for (let i = 0; i < rows.length; i += FLUSH_CHUNK) {
                const {sql, params} = buildFlushStatement(this.cfg.vaultId, rows.slice(i, i + FLUSH_CHUNK));
                await conn.query(sql, params);
            }
            await conn.commit();
        } catch (err) {
            await conn.rollback().catch(() => undefined);
            for (const [id, older] of batch) {
                const newer = this.dirtyEntries.get(id);
                this.dirtyEntries.set(id, newer === undefined ? older : mergeDirty(older, newer));
            }
            throw err;
        } finally {
            await conn.release();
        }
    }

    public syncEntries(): Promise<boolean> {
        // DB is the SoT — no parallel-process sidecar to re-read.
        return Promise.resolve(false);
    }

    private withBacklinks(note: Note): Note {
        const backlinks = this.links.backlinksOf(note.id);
        if (backlinks.length === 0) {
            return note;
        }
        return {...note, backlinks};
    }

    private indexNote(note: Note): void {
        const prev = this.notes.get(note.id);
        this.notes.set(note.id, note);

        if (prev) {
            for (const tag of prev.tags) {
                const bucket = this.tagIndex.get(tag);
                bucket?.delete(prev.id);
                if (bucket && bucket.size === 0) this.tagIndex.delete(tag);
            }
        }

        for (const tag of note.tags) {
            let bucket = this.tagIndex.get(tag);
            if (!bucket) {
                bucket = new Set();
                this.tagIndex.set(tag, bucket);
            }
            bucket.add(note.id);
        }

        this.links.upsert(note);
    }

    private unindexNote(id: NoteId): void {
        const note = this.notes.get(id);
        if (!note) return;
        this.notes.delete(id);
        for (const tag of note.tags) {
            const bucket = this.tagIndex.get(tag);
            bucket?.delete(id);
            if (bucket && bucket.size === 0) this.tagIndex.delete(tag);
        }
        this.links.remove(id);
    }
}
