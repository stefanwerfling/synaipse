import {mkdir, readFile, stat, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import {access} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {Repo, type PersonInput} from 'ngit';
import {NotFoundError, VaultError, validateFrontmatter} from '@synaipse/core';
import type {Note, NoteId, NoteWriteInput, Frontmatter} from '@synaipse/core';
import {parseNote} from './Parser.js';
import {walkMarkdown} from './Walker.js';

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
    private readonly backlinkIndex = new Map<string, Set<NoteId>>();
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
        this.notes.clear();
        this.backlinkIndex.clear();

        for await (const file of walkMarkdown(this.root)) {
            await this.ingestFile(file);
        }

        this.rebuildBacklinks();
        this.loaded = true;
    }

    public isLoaded(): boolean {
        return this.loaded;
    }

    public list(): Note[] {
        return [...this.notes.values()];
    }

    public get(id: NoteId): Note {
        const note = this.notes.get(id);

        if (!note) {
            throw new NotFoundError(`Note not found: ${id}`);
        }

        return note;
    }

    public tryGet(id: NoteId): Note | undefined {
        return this.notes.get(id);
    }

    public async read(id: NoteId): Promise<Note> {
        const cached = this.notes.get(id);

        if (cached) {
            return cached;
        }

        const absolute = this.toAbsolute(id);
        await this.ingestFile(absolute);
        this.rebuildBacklinks();

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
        this.rebuildBacklinks();

        const id = this.toId(absolute);
        await this.autoCommit(id, ctx, 'write');

        return this.get(id);
    }

    public async delete(id: NoteId, ctx: CommitContext = {}): Promise<void> {
        const absolute = this.toAbsolute(id);
        await rm(absolute, {force: true});
        this.notes.delete(id);
        this.rebuildBacklinks();
        await this.autoCommit(id, ctx, 'delete');
    }

    private async autoCommit(id: NoteId, ctx: CommitContext, kind: 'write' | 'delete'): Promise<void> {
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
            process.stderr.write(`[synaipse] ${kind} commit failed for ${id}: ${String(cause)}\n`);
        }
    }

    public backlinksOf(id: NoteId): NoteId[] {
        const note = this.notes.get(id);

        if (!note) {
            return [];
        }

        // Wikilinks may reference a note by its title OR by any of its
        // aliases (matches the frontend resolver in
        // packages/web/src/Wikilinks.ts). Union the lookups so callers get
        // a complete list regardless of which key the linker used.
        const out = new Set<NoteId>();

        const collect = (key: string): void => {
            const set = this.backlinkIndex.get(key);
            if (set) {
                for (const linker of set) {
                    out.add(linker);
                }
            }
        };

        if (note.title.length > 0) {
            collect(note.title);
        }

        const aliases = note.frontmatter.aliases;
        if (aliases !== undefined) {
            for (const alias of aliases) {
                if (alias.length > 0) {
                    collect(alias);
                }
            }
        }

        return [...out];
    }

    public tags(): Map<string, NoteId[]> {
        const result = new Map<string, NoteId[]>();

        for (const note of this.notes.values()) {
            for (const tag of note.tags) {
                const list = result.get(tag) ?? [];
                list.push(note.id);
                result.set(tag, list);
            }
        }

        return result;
    }

    public async handleExternalChange(absolutePath: string, kind: 'created' | 'updated' | 'deleted'): Promise<void> {
        const id = this.toId(absolutePath);

        if (kind === 'deleted') {
            this.notes.delete(id);
        } else {
            await this.ingestFile(absolutePath);
        }

        this.rebuildBacklinks();
    }

    private async ingestFile(absolutePath: string): Promise<void> {
        const raw = await readFile(absolutePath, 'utf8');
        const info = await stat(absolutePath);

        const note = parseNote({
            vaultRoot: this.root,
            absolutePath,
            raw,
            mtime: info.mtimeMs
        });

        const validation = validateFrontmatter(note.frontmatter);

        if (!validation.ok) {
            console.warn(`[synaipse] invalid frontmatter in ${note.id}: ${validation.errors.join('; ')}`);
        }

        this.notes.set(note.id, note);
    }

    private rebuildBacklinks(): void {
        this.backlinkIndex.clear();

        // Build a key→noteId lookup from titles AND aliases. Title wins
        // on collision; aliases register only if the key isn't already
        // taken. Matches packages/web/src/Wikilinks.ts so the frontend
        // and backend agree on which note a wikilink resolves to.
        const keyToId = new Map<string, NoteId>();

        for (const note of this.notes.values()) {
            if (note.title.length > 0 && !keyToId.has(note.title)) {
                keyToId.set(note.title, note.id);
            }
        }

        for (const note of this.notes.values()) {
            const aliases = note.frontmatter.aliases;
            if (aliases === undefined) continue;

            for (const alias of aliases) {
                if (alias.length > 0 && !keyToId.has(alias)) {
                    keyToId.set(alias, note.id);
                }
            }
        }

        for (const note of this.notes.values()) {
            note.backlinks = [];
        }

        for (const note of this.notes.values()) {
            for (const link of note.wikilinks) {
                const targetId = keyToId.get(link);
                const set = this.backlinkIndex.get(link) ?? new Set<NoteId>();
                set.add(note.id);
                this.backlinkIndex.set(link, set);

                if (targetId !== undefined) {
                    const target = this.notes.get(targetId);

                    if (target && !target.backlinks.includes(note.id)) {
                        target.backlinks.push(note.id);
                    }
                }
            }
        }
    }

    private assembleMarkdown(content: string, frontmatter?: Frontmatter): string {
        if (!frontmatter || Object.keys(frontmatter).length === 0) {
            return content;
        }

        return matter.stringify(content, frontmatter);
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