import {mkdir, readFile, stat, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import {NotFoundError, VaultError, validateFrontmatter} from '@synaipse/core';
import type {Note, NoteId, NoteWriteInput, Frontmatter} from '@synaipse/core';
import {parseNote} from './Parser.js';
import {walkMarkdown} from './Walker.js';

export class Vault {
    private readonly notes = new Map<NoteId, Note>();
    private readonly backlinkIndex = new Map<string, Set<NoteId>>();
    private loaded = false;

    public constructor(public readonly root: string) {}

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

    public async write(input: NoteWriteInput): Promise<Note> {
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

        return this.get(this.toId(absolute));
    }

    public async delete(id: NoteId): Promise<void> {
        const absolute = this.toAbsolute(id);
        await rm(absolute, {force: true});
        this.notes.delete(id);
        this.rebuildBacklinks();
    }

    public backlinksOf(id: NoteId): NoteId[] {
        const note = this.notes.get(id);

        if (!note) {
            return [];
        }

        return [...(this.backlinkIndex.get(note.title) ?? new Set<NoteId>())];
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

        const titleToId = new Map<string, NoteId>();
        for (const note of this.notes.values()) {
            titleToId.set(note.title, note.id);
        }

        for (const note of this.notes.values()) {
            note.backlinks = [];
        }

        for (const note of this.notes.values()) {
            for (const link of note.wikilinks) {
                const targetId = titleToId.get(link);
                const set = this.backlinkIndex.get(link) ?? new Set<NoteId>();
                set.add(note.id);
                this.backlinkIndex.set(link, set);

                if (targetId) {
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