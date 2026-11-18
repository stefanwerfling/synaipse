import {createHash} from 'node:crypto';
import type {Pool} from 'mariadb';
import {
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

interface DirtyEntry {
    hash?: string;
    mtime?: number;
    accessCount?: number;
    lastAccessed?: number;
    referencedCount?: number;
    lastReferenced?: number;
    embeddedHash?: string;
    embedModel?: string;
}

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
            dirty.accessCount = existing.accessCount;
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
            accessCount: 1,
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
            dirty.referencedCount = existing.referencedCount;
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
            referencedCount: 1,
            lastReferenced: now
        });
    }

    public removeEntry(id: NoteId): void {
        this.entries.delete(id);
        this.dirtyEntries.delete(id);
    }

    public async flushEntries(): Promise<void> {
        if (this.dirtyEntries.size === 0) {
            return;
        }

        const conn = await this.pool.getConnection();
        try {
            await conn.beginTransaction();
            for (const [id, dirty] of this.dirtyEntries) {
                await conn.query(
                    `UPDATE notes
                     SET hash = COALESCE(?, hash),
                         mtime_ms = COALESCE(?, mtime_ms),
                         access_count = COALESCE(?, access_count),
                         last_accessed = COALESCE(?, last_accessed),
                         referenced_count = COALESCE(?, referenced_count),
                         last_referenced = COALESCE(?, last_referenced),
                         embedded_hash = COALESCE(?, embedded_hash),
                         embed_model = COALESCE(?, embed_model)
                     WHERE vault_id = ? AND note_path = ?`,
                    [
                        dirty.hash ?? null,
                        dirty.mtime ?? null,
                        dirty.accessCount ?? null,
                        dirty.lastAccessed ?? null,
                        dirty.referencedCount ?? null,
                        dirty.lastReferenced ?? null,
                        dirty.embeddedHash ?? null,
                        dirty.embedModel ?? null,
                        this.cfg.vaultId,
                        id
                    ]
                );
            }
            await conn.commit();
            this.dirtyEntries.clear();
        } catch (err) {
            await conn.rollback();
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
