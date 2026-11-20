import {EventEmitter} from 'node:events';
import {watch, type FSWatcher} from 'node:fs';
import {lstat, readdir} from 'node:fs/promises';
import path from 'node:path';
import {createLogger, type VaultEvent} from '@synaipse/core';
import {isIgnoredPath} from './Walker.js';

const log = createLogger('watcher');

export interface VaultWatcherOptions {
    /**
     * A path is checked once no event arrived for it this long, so a file
     * still being written is reported once, when it is complete (what
     * chokidar's awaitWriteFinish did). Default 200 ms.
     */
    stabilityMs?: number;
    /**
     * One native recursive watch on the root instead of one watch per
     * directory. Default: on macOS and Windows, where the OS provides it.
     * On Linux Node emulates it, so per-directory inotify watches are used.
     */
    recursive?: boolean;
}

interface FileState {
    mtimeMs: number;
    size: number;
}

/** A note seen by the start-up walk without a stat; differs from every real state. */
const UNKNOWN: FileState = Object.freeze({mtimeMs: -1, size: -1});

/**
 * Reports created, changed and deleted notes (`.md`) below the vault root
 * (plan A1 follow-up, replaces chokidar). chokidar watched every file and,
 * on any event in a directory, read the whole directory again; at 50k
 * notes that was ~80 % of a write's cost and an 18 s start-up walk. Here a
 * directory watch names the file that changed and only that file is
 * looked at. Ignored like the initial scan ({@link isIgnoredPath}); like
 * the walker, symlinks are not followed. Events that existed before
 * start() are not reported.
 */
export class VaultWatcher extends EventEmitter {
    private readonly stabilityMs: number;
    private readonly recursive: boolean;
    /** Known notes → their last seen state, to tell created from updated. */
    private readonly files = new Map<string, FileState>();
    /** Known directories → their watch (null with one recursive root watch). */
    private readonly dirs = new Map<string, FSWatcher | null>();
    private rootWatcher: FSWatcher | null = null;
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private running = false;
    private warnedLimit = false;

    public constructor(private readonly vaultRoot: string, opts: VaultWatcherOptions = {}) {
        super();
        this.vaultRoot = path.resolve(vaultRoot);
        this.stabilityMs = opts.stabilityMs ?? 200;
        this.recursive = opts.recursive ?? (process.platform === 'darwin' || process.platform === 'win32');
    }

    public start(): void {
        if (this.running) {
            return;
        }

        this.running = true;

        if (this.recursive) {
            this.rootWatcher = this.open(this.vaultRoot);
        }

        void this.addDir(this.vaultRoot, false);
    }

    public async stop(): Promise<void> {
        if (!this.running) {
            return;
        }

        this.running = false;

        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        this.rootWatcher?.close();
        this.rootWatcher = null;
        for (const watcher of this.dirs.values()) watcher?.close();
        this.dirs.clear();
        this.files.clear();
    }

    private ignored(p: string): boolean {
        return isIgnoredPath(path.relative(this.vaultRoot, p));
    }

    /** A watch on `dir` whose events name a child (or, recursive, a descendant). */
    private open(dir: string): FSWatcher | null {
        try {
            const watcher = watch(dir, {persistent: true, recursive: this.recursive}, (_type, name) => {
                if (name === null) {
                    void this.rescan(dir);
                } else {
                    this.schedule(path.join(dir, name.toString()));
                }
            });
            watcher.on('error', () => {
                // Typically the directory itself went away (EPERM on Windows).
                watcher.close();
                if (this.dirs.get(dir) === watcher) this.dirs.delete(dir);
                this.schedule(dir);
            });
            return watcher;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOSPC' || code === 'EMFILE') {
                if (!this.warnedLimit) {
                    this.warnedLimit = true;
                    log.warn('watch limit reached; changes in some folders are not seen until restart', {dir, code});
                }
            } else if (code !== 'ENOENT') {
                log.warn('cannot watch directory', {dir, error: String(err)});
            }
            return null;
        }
    }

    /** Watch `dir` and everything below it; `announce` reports the notes found as created. */
    private async addDir(dir: string, announce: boolean): Promise<void> {
        if (!this.running || this.dirs.has(dir) || (dir !== this.vaultRoot && this.ignored(dir))) {
            return;
        }

        // Watch first, then list: a file written in between is seen either way.
        this.dirs.set(dir, this.recursive ? null : this.open(dir));

        let entries;
        try {
            entries = await readdir(dir, {withFileTypes: true});
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!this.running) {
                return;
            }

            const full = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                await this.addDir(full, announce);
            } else if (entry.isFile() && entry.name.endsWith('.md') && !this.ignored(full)) {
                if (announce) {
                    await this.check(full, true);
                } else if (!this.files.has(full)) {
                    // Start-up: no stat per note (50k of them). The next event
                    // on it then counts as a change, as with chokidar.
                    this.files.set(full, UNKNOWN);
                }
            }
        }
    }

    private schedule(p: string): void {
        if (!this.running || this.ignored(p)) {
            return;
        }

        clearTimeout(this.timers.get(p));
        this.timers.set(p, setTimeout(() => {
            this.timers.delete(p);
            void this.check(p, true);
        }, this.stabilityMs));
    }

    /** Compare `p` with what is known about it and report the difference. */
    private async check(p: string, announce: boolean): Promise<void> {
        let stats;
        try {
            stats = await lstat(p);
        } catch {
            stats = null;
        }

        if (!this.running) {
            return;
        }

        if (stats === null) {
            this.forget(p);
            return;
        }

        if (stats.isDirectory()) {
            await this.addDir(p, true);
            return;
        }

        if (!stats.isFile() || !p.endsWith('.md')) {
            return;
        }

        // Read and write the state together, after the await: of two checks
        // racing for one file only the first reports it.
        const prev = this.files.get(p);
        this.files.set(p, {mtimeMs: stats.mtimeMs, size: stats.size});

        if (!announce) {
            return;
        }

        if (prev === undefined) {
            this.report('created', p);
        } else if (prev.mtimeMs !== stats.mtimeMs || prev.size !== stats.size) {
            this.report('updated', p);
        }
    }

    /** `p` is gone: a note, or a directory with everything known below it. */
    private forget(p: string): void {
        if (this.files.delete(p)) {
            this.report('deleted', p);
            return;
        }

        if (!this.dirs.has(p)) {
            return;
        }

        const prefix = p + path.sep;
        for (const [dir, watcher] of this.dirs) {
            if (dir === p || dir.startsWith(prefix)) {
                watcher?.close();
                this.dirs.delete(dir);
            }
        }
        for (const file of [...this.files.keys()]) {
            if (file.startsWith(prefix)) {
                this.files.delete(file);
                this.report('deleted', file);
            }
        }
    }

    /** An event without a file name: compare the directory's children with what is known. */
    private async rescan(dir: string): Promise<void> {
        let names: string[];
        try {
            names = await readdir(dir);
        } catch {
            names = [];
        }

        const present = new Set(names.map((n) => path.join(dir, n)));
        for (const child of present) this.schedule(child);
        for (const known of [...this.files.keys(), ...this.dirs.keys()]) {
            if (path.dirname(known) === dir && !present.has(known)) this.schedule(known);
        }
    }

    private report(kind: VaultEvent['kind'], p: string): void {
        const event: VaultEvent = {kind, path: p};
        this.emit('event', event);
    }
}
