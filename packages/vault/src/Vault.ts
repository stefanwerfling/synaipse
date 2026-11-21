import {mkdir, readFile, stat, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {access} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {Repo, type PersonInput} from 'ngit';
import {createLogger, LinkIndex, NotFoundError, VaultError, validateFrontmatter} from '@synaipse/core';
import type {Note, NoteId, NoteWriteInput, Frontmatter} from '@synaipse/core';
import {stringifyFrontMatter} from './FrontMatter.js';
import {parseNote} from './Parser.js';
import {walkMarkdown} from './Walker.js';
import {currentWriteBatch} from './WriteBatch.js';
import type {WriteBatchChanges} from '@synaipse/core';

/** Files read concurrently during the initial load. */
const LOAD_CONCURRENCY = 32;

const log = createLogger('vault');

export interface VaultHistoryConfig {
    autoCommit: boolean;
    author: PersonInput;
}

export interface VaultOptions {
    history?: VaultHistoryConfig;
}

export interface CommitContext {
    message?: string;
    author?: PersonInput;
}

export class Vault {
    private readonly notes = new Map<NoteId, Note>();
    /**
     * Incremental wikilink index (shared with the MariaDB adapter): a write
     * touches only the written note's links instead of rescanning the vault.
     */
    private readonly links = new LinkIndex();
    /** tag → ids, maintained incrementally alongside {@link links}. */
    private readonly tagIndex = new Map<string, Set<NoteId>>();
    /** See {@link list}; null after any change to {@link notes}. */
    private listCache: Note[] | null = null;
    private loaded = false;
    private readonly historyConfig: VaultHistoryConfig | null;
    private repo: Repo | null = null;

    public constructor(public readonly root: string, opts: VaultOptions = {}) {
        this.historyConfig = opts.history ?? null;
    }

    /** True when the history feature is configured for this vault — irrespective of whether the first commit has been made yet. The UI uses this to decide whether to surface the History button at all. */
    public isHistoryConfigured(): boolean {
        return this.historyConfig !== null;
    }

    /** True when writes will autocommit. */
    public isAutoCommitEnabled(): boolean {
        return this.historyConfig !== null && this.historyConfig.autoCommit;
    }

    /** Returns the ngit Repo for read-only ops (history, show, diff). Returns null when history is disabled or the repo has not been initialised yet (no Synaipse commit has happened). */
    public async getRepo(): Promise<Repo | null> {
        if (this.historyConfig === null) {
            return null;
        }

        if (this.repo !== null) {
            return this.repo;
        }

        try {
            await access(`${this.root}/.ngit/HEAD`, fsConstants.F_OK);
        } catch {
            return null;
        }

        this.repo = await Repo.open(this.root, {defaultAuthor: this.historyConfig.author});
        return this.repo;
    }

    private async ensureRepoForCommit(): Promise<Repo | null> {
        if (this.historyConfig === null || !this.historyConfig.autoCommit) {
            return null;
        }

        if (this.repo === null) {
            this.repo = await Repo.openOrInit(this.root, {
                defaultAuthor: this.historyConfig.author
            });
        }

        return this.repo;
    }

    public async load(): Promise<void> {
        await this.ensureRoot();
        this.listCache = null;
        this.notes.clear();
        this.links.clear();
        this.tagIndex.clear();

        // Read + stat with bounded parallelism (plan P4 / A4); indexing
        // stays sequential and in walk order, so the result is identical
        // to the old one-file-at-a-time load.
        const files: string[] = [];
        for await (const file of walkMarkdown(this.root)) {
            files.push(file);
        }

        for (let i = 0; i < files.length; i += LOAD_CONCURRENCY) {
            const batch = await Promise.all(files.slice(i, i + LOAD_CONCURRENCY).map((file) => this.readSource(file)));
            for (const source of batch) {
                this.applySource(source);
            }
        }

        this.loaded = true;
    }

    public isLoaded(): boolean {
        return this.loaded;
    }

    /**
     * The note list with backlinks, built once per vault state (plan A1):
     * dropped on every change, so callers between writes share one array
     * instead of copying every note. Frozen, because it is shared.
     */
    public list(): Note[] {
        if (this.listCache === null) {
            this.listCache = Object.freeze([...this.notes.values()].map((n) => Object.freeze(this.withBacklinks(n)))) as Note[];
        }
        return this.listCache;
    }

    public get(id: NoteId): Note {
        const note = this.notes.get(id);

        if (!note) {
            throw new NotFoundError(`Note not found: ${id}`);
        }

        return this.withBacklinks(note);
    }

    public tryGet(id: NoteId): Note | undefined {
        const note = this.notes.get(id);
        return note === undefined ? undefined : this.withBacklinks(note);
    }

    /** Backlinks are derived on read (memoised in LinkIndex), never stored on the note. */
    private withBacklinks(note: Note): Note {
        return {...note, backlinks: this.links.backlinksOf(note.id)};
    }

    public async read(id: NoteId): Promise<Note> {
        if (this.notes.has(id)) {
            return this.get(id);
        }

        const absolute = this.toAbsolute(id);
        await this.ingestFile(absolute);

        return this.get(id);
    }

    public async write(input: NoteWriteInput, ctx: CommitContext = {}): Promise<Note> {
        if (input.frontmatter) {
            const validation = validateFrontmatter(input.frontmatter);

            if (!validation.ok) {
                throw new VaultError(
                    `Invalid frontmatter for ${input.path}: ${validation.errors.join('; ')}`
                );
            }
        }

        const absolute = this.toAbsolute(input.path);
        await mkdir(path.dirname(absolute), {recursive: true});

        const body = this.assembleMarkdown(input.content, input.frontmatter);
        await writeFile(absolute, body, 'utf8');

        await this.ingestFile(absolute);

        const id = this.toId(absolute);
        await this.autoCommit(id, ctx, 'write');

        return this.get(id);
    }

    public async delete(id: NoteId, ctx: CommitContext = {}): Promise<void> {
        const absolute = this.toAbsolute(id);
        await rm(absolute, {force: true});
        this.forget(id);
        await this.autoCommit(id, ctx, 'delete');
    }

    private async autoCommit(id: NoteId, ctx: CommitContext, kind: 'write' | 'delete'): Promise<void> {
        const batch = currentWriteBatch();
        if (batch !== undefined) {
            // Committed once, together with the rest, in commitBatch().
            if (kind === 'write') batch.recordWrite(id);
            else batch.recordDelete(id);
            return;
        }

        const repo = await this.ensureRepoForCommit();

        if (repo === null) {
            return;
        }

        const message = ctx.message ?? `synaipse: ${kind} ${id}`;
        const author = ctx.author ?? this.historyConfig?.author;

        try {
            if (kind === 'write') {
                await repo.commitFile(id, {message, ...(author ? {author} : {})});
            } else {
                await repo.deleteFile(id, {message, ...(author ? {author} : {})});
            }
        } catch (cause) {
            log.error('history commit failed', {kind, noteId: id, error: cause});
        }
    }

    /** One atomic ngit commit for every path a write batch touched. */
    public async commitBatch(changes: WriteBatchChanges, ctx: CommitContext = {}): Promise<void> {
        if (changes.adds.size === 0 && changes.deletes.size === 0) return;
        const repo = await this.ensureRepoForCommit();
        if (repo === null) return;

        const adds: Array<{path: string; content: Buffer}> = [];
        const deletes: string[] = [];
        for (const rel of changes.adds) {
            try {
                adds.push({path: rel, content: await readFile(this.toAbsolute(rel))});
            } catch {
                deletes.push(rel); // gone again by the end of the batch
            }
        }
        deletes.push(...changes.deletes);

        // A note created and removed inside the same batch was never
        // committed; asking ngit to delete it would fail the whole commit.
        const head = await repo.head();
        const committedDeletes: string[] = [];
        for (const rel of deletes) {
            if (head === null) continue;
            try {
                await repo.show(head, rel);
                committedDeletes.push(rel);
            } catch {
                // not in HEAD — nothing to delete
            }
        }
        if (adds.length === 0 && committedDeletes.length === 0) return;

        const message = ctx.message ?? `synaipse: batch (${adds.length} written, ${committedDeletes.length} deleted)`;
        const author = ctx.author ?? this.historyConfig?.author;
        try {
            await repo.commitFiles({adds, deletes: committedDeletes, message, ...(author ? {author} : {})});
        } catch (cause) {
            log.error('batch history commit failed', {paths: adds.length + committedDeletes.length, error: cause});
        }
    }

    /** See NoteAdapter.resolveLink. */
    public resolveLink(key: string): NoteId | undefined {
        return key.length === 0 ? undefined : this.links.resolve(key);
    }

    public backlinksOf(id: NoteId): NoteId[] {
        // Title before alias, first note wins — the same rule as graph(),
        // related() and the MariaDB adapter (see core/LinkIndex).
        return this.links.backlinksOf(id);
    }

    public tags(): Map<string, NoteId[]> {
        const result = new Map<string, NoteId[]>();

        for (const [tag, ids] of this.tagIndex) {
            result.set(tag, [...ids]);
        }

        return result;
    }

    public async handleExternalChange(absolutePath: string, kind: 'created' | 'updated' | 'deleted'): Promise<void> {
        const id = this.toId(absolutePath);

        if (kind === 'deleted') {
            this.forget(id);
        } else {
            await this.ingestFile(absolutePath);
        }
    }

    private async ingestFile(absolutePath: string): Promise<void> {
        this.applySource(await this.readSource(absolutePath));
    }

    private async readSource(absolutePath: string): Promise<{absolutePath: string; raw: string; mtime: number}> {
        const [raw, info] = await Promise.all([readFile(absolutePath, 'utf8'), stat(absolutePath)]);
        return {absolutePath, raw, mtime: info.mtimeMs};
    }

    private applySource({absolutePath, raw, mtime}: {absolutePath: string; raw: string; mtime: number}): void {
        const note = parseNote({
            vaultRoot: this.root,
            absolutePath,
            raw,
            mtime
        });

        const validation = validateFrontmatter(note.frontmatter);

        if (!validation.ok) {
            log.warn('invalid frontmatter', {noteId: note.id, errors: validation.errors});
        }

        this.unindexTags(this.notes.get(note.id));
        this.listCache = null;
        this.notes.set(note.id, note);
        this.links.upsert(note);
        for (const tag of note.tags) {
            let ids = this.tagIndex.get(tag);
            if (ids === undefined) this.tagIndex.set(tag, ids = new Set());
            ids.add(note.id);
        }
    }

    private forget(id: NoteId): void {
        this.unindexTags(this.notes.get(id));
        this.listCache = null;
        this.notes.delete(id);
        this.links.remove(id);
    }

    private unindexTags(note: Note | undefined): void {
        if (note === undefined) return;
        for (const tag of note.tags) {
            const ids = this.tagIndex.get(tag);
            if (ids === undefined) continue;
            ids.delete(note.id);
            if (ids.size === 0) this.tagIndex.delete(tag);
        }
    }

    private assembleMarkdown(content: string, frontmatter?: Frontmatter): string {
        if (!frontmatter || Object.keys(frontmatter).length === 0) {
            return content;
        }

        return stringifyFrontMatter(content, frontmatter);
    }

    private async ensureRoot(): Promise<void> {
        try {
            const info = await stat(this.root);

            if (!info.isDirectory()) {
                throw new VaultError(`Vault root is not a directory: ${this.root}`);
            }
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
                await mkdir(this.root, {recursive: true});
                return;
            }

            throw new VaultError(`Cannot access vault root: ${this.root}`, cause);
        }
    }

    private toAbsolute(idOrPath: string): string {
        if (path.isAbsolute(idOrPath)) {
            return idOrPath;
        }

        const withExt = idOrPath.endsWith('.md') ? idOrPath : `${idOrPath}.md`;

        return path.join(this.root, withExt);
    }

    private toId(absolutePath: string): NoteId {
        return path.relative(this.root, absolutePath).replaceAll(path.sep, '/');
    }
}