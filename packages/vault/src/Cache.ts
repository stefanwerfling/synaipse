import {existsSync} from 'node:fs';
import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createLogger, LEGACY_EMBED_MODEL} from '@synaipse/core';

const log = createLogger('vault');

/** `embeddedHash` value of an entry whose content was never embedded. */
const NOT_EMBEDDED = '';

export interface CacheEntry {
    hash: string;
    mtime: number;
    accessCount?: number;
    lastAccessed?: number;
    /**
     * Distinct from accessCount: bumped only when a note is named in a
     * synaipse_log_session `references` list, i.e. Claude explicitly said
     * this note was actually used for the session's outcome — not merely
     * retrieved. accessCount fires on every search/related hit regardless
     * of relevance, so it can't answer "was this useful"; this can.
     */
    referencedCount?: number;
    lastReferenced?: number;
    /** See NoteEntry.embeddedHash in @synaipse/core. */
    embeddedHash?: string;
    /** See NoteEntry.embedModel in @synaipse/core. */
    embedModel?: string;
}

export interface TouchSeed {
    hash: string;
    mtime: number;
}

export class HashCache {
    private data = new Map<string, CacheEntry>();
    private dirty = false;
    private flushTimer: NodeJS.Timeout | null = null;
    private flushing: Promise<void> | null = null;
    private knownMtime: number | null = null;

    public constructor(
        private readonly file: string,
        private readonly debounceMs: number = 500
    ) {}

    public async load(): Promise<void> {
        if (!existsSync(this.file)) {
            return;
        }

        let raw: string;
        try {
            raw = await readFile(this.file, 'utf8');
        } catch (error) {
            log.warn('cannot read index cache', {file: this.file, error});
            this.data = new Map();
            return;
        }

        try {
            const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
            this.data = new Map(Object.entries(parsed));
            // Entries from before embeddedHash existed: their `hash` was
            // only recorded after a successful start-up embed, so adopt it
            // as the embedded state under an explicit LEGACY_EMBED_MODEL
            // marker. Without the marker a brand-new, never-embedded entry
            // would be indistinguishable from a legacy one.
            for (const entry of this.data.values()) {
                if (entry.embedModel === undefined && entry.embeddedHash === undefined) {
                    entry.embeddedHash = entry.hash;
                    entry.embedModel = LEGACY_EMBED_MODEL;
                }
            }
            this.knownMtime = await this.diskMtime();
        } catch (error) {
            // A corrupt cache used to reset silently, which made the next
            // start re-embed the whole vault without a word. Keep the
            // broken file for inspection and say loudly what happens next.
            const backup = `${this.file}.corrupt-${Date.now()}`;
            await rename(this.file, backup).catch(() => undefined);
            log.warn('index cache is corrupt; moved aside, all notes will be re-embedded', {file: this.file, backup, error});
            this.data = new Map();
        }
    }

    /**
     * Re-read the cache file if its mtime changed since we last loaded — used
     * by the watcher to pick up writes made by a parallel CLI process (e.g.
     * `npm run relink`) before deciding whether to re-embed.
     */
    public async reloadIfChanged(): Promise<boolean> {
        const mtime = await this.diskMtime();
        if (mtime === null || mtime === this.knownMtime) return false;

        await this.load();
        return true;
    }

    private async diskMtime(): Promise<number | null> {
        try {
            const s = await stat(this.file);
            return s.mtimeMs;
        } catch {
            return null;
        }
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

        if (prev && prev.hash === entry.hash && prev.mtime === entry.mtime) {
            return;
        }

        const merged: CacheEntry = {...entry};

        if (prev?.accessCount !== undefined) {
            merged.accessCount = prev.accessCount;
        }

        if (prev?.lastAccessed !== undefined) {
            merged.lastAccessed = prev.lastAccessed;
        }

        if (prev?.referencedCount !== undefined) {
            merged.referencedCount = prev.referencedCount;
        }

        if (prev?.lastReferenced !== undefined) {
            merged.lastReferenced = prev.lastReferenced;
        }

        if (merged.embeddedHash === undefined) {
            // '' = explicitly "not embedded yet". Must be persisted as a
            // value: an absent field is how legacy entries are recognised
            // on load, and those count as embedded.
            merged.embeddedHash = prev?.embeddedHash ?? NOT_EMBEDDED;
        }

        if (merged.embedModel === undefined && prev?.embedModel !== undefined) {
            merged.embedModel = prev.embedModel;
        }


        this.data.set(id, merged);
        this.schedule();
    }

    /** Mark `hash` as embedded with `model` (see NoteEntry.embeddedHash). */
    public setEmbedded(id: string, hash: string, model: string): void {
        const existing = this.data.get(id);

        if (existing === undefined) {
            this.data.set(id, {hash, mtime: 0, embeddedHash: hash, embedModel: model});
            this.schedule();
            return;
        }

        if (existing.embeddedHash === hash && existing.embedModel === model) {
            return;
        }

        existing.embeddedHash = hash;
        existing.embedModel = model;
        this.schedule();
    }

    public touch(id: string, seed?: TouchSeed, now: number = Date.now()): void {
        const existing = this.data.get(id);

        if (existing) {
            existing.accessCount = (existing.accessCount ?? 0) + 1;
            existing.lastAccessed = now;
            this.schedule();
            return;
        }

        if (!seed) {
            return;
        }

        this.data.set(id, {
            hash: seed.hash,
            mtime: seed.mtime,
            accessCount: 1,
            lastAccessed: now,
            embeddedHash: NOT_EMBEDDED
        });
        this.schedule();
    }

    /** Same shape as touch(), but bumps referencedCount/lastReferenced instead. */
    public touchReference(id: string, seed?: TouchSeed, now: number = Date.now()): void {
        const existing = this.data.get(id);

        if (existing) {
            existing.referencedCount = (existing.referencedCount ?? 0) + 1;
            existing.lastReferenced = now;
            this.schedule();
            return;
        }

        if (!seed) {
            return;
        }

        this.data.set(id, {
            hash: seed.hash,
            mtime: seed.mtime,
            referencedCount: 1,
            lastReferenced: now,
            embeddedHash: NOT_EMBEDDED
        });
        this.schedule();
    }

    public delete(id: string): void {
        if (!this.data.delete(id)) {
            return;
        }

        this.schedule();
    }

    public async flush(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        if (this.flushing) {
            await this.flushing;
            return;
        }

        if (!this.dirty) {
            return;
        }

        this.flushing = this.writeFile();

        try {
            await this.flushing;
        } finally {
            this.flushing = null;
        }
    }

    private schedule(): void {
        this.dirty = true;

        if (this.flushTimer) {
            return;
        }

        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush().catch(() => {
                // best-effort; next mutation reschedules
            });
        }, this.debounceMs);
    }

    private async writeFile(): Promise<void> {
        this.dirty = false;
        await mkdir(path.dirname(this.file), {recursive: true});
        const obj: Record<string, CacheEntry> = Object.fromEntries(this.data);
        // Atomic replace: a crash mid-write must never leave a truncated
        // JSON behind (that would force a full re-embed on next start).
        const tmp = `${this.file}.tmp-${process.pid}`;
        try {
            await writeFile(tmp, JSON.stringify(obj), 'utf8');
            await rename(tmp, this.file);
        } catch (error) {
            this.dirty = true;
            await rm(tmp, {force: true}).catch(() => undefined);
            throw error;
        }
        this.knownMtime = await this.diskMtime();
    }
}