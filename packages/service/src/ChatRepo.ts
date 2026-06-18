import {existsSync} from 'node:fs';
import {mkdir, readdir, readFile, stat, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type {Frontmatter, Note} from '@synaipse/core';
import {
    parseChatSession,
    serializeChatSession,
    summarizeChat,
    type ChatSession,
    type ChatSummary
} from './ChatStore.js';

/**
 * Disk-backed chat store, deliberately separate from the vault. Chat
 * conversations live in `<chatStoreDir>/<id>.md` and are NOT scanned by
 * the vault, so they don't pollute the notes list, the graph, or any
 * search index. Promoting a chat into a vault note is an explicit user
 * action handled elsewhere — this module only owns the chat layer.
 *
 * File format mirrors what's used elsewhere (gray-matter frontmatter +
 * markdown body with HTML-comment turn markers), so a chat file is still
 * human-readable if opened in any editor — the difference is purely
 * about where it lives and who scans it.
 */
export class ChatRepo {
    public constructor(private readonly storeDir: string) {}

    private filePath(id: string): string {
        // Defence-in-depth: refuse ids that would escape the store dir
        // (e.g. "../../etc/passwd.md"). storeDir is trusted, ids come
        // from API callers and from prior file scans.
        const safe = id.replace(/^\/+/, '');
        if (safe.includes('..')) throw new Error(`invalid chat id: ${id}`);
        return path.join(this.storeDir, safe);
    }

    private async ensureDir(): Promise<void> {
        if (!existsSync(this.storeDir)) {
            await mkdir(this.storeDir, {recursive: true});
        }
    }

    public async list(): Promise<ChatSummary[]> {
        if (!existsSync(this.storeDir)) return [];

        const out: ChatSummary[] = [];

        for await (const file of walkMarkdown(this.storeDir)) {
            const id = path.relative(this.storeDir, file).replaceAll(path.sep, '/');
            const note = await this.readAsNote(id, file);
            if (note === null) continue;
            out.push(summarizeChat(note));
        }

        out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        return out;
    }

    public async get(id: string): Promise<ChatSession> {
        const file = this.filePath(id);
        if (!existsSync(file)) throw new Error(`chat not found: ${id}`);

        const note = await this.readAsNote(id, file);
        if (note === null) throw new Error(`could not read chat: ${id}`);
        return parseChatSession(note);
    }

    public async tryGet(id: string): Promise<ChatSession | null> {
        try {
            return await this.get(id);
        } catch {
            return null;
        }
    }

    public async write(session: ChatSession): Promise<void> {
        await this.ensureDir();
        const {content, frontmatter} = serializeChatSession(session);
        const raw = matter.stringify(content, frontmatter as Record<string, unknown>);
        const file = this.filePath(session.id);
        const dir = path.dirname(file);
        if (!existsSync(dir)) await mkdir(dir, {recursive: true});
        await writeFile(file, raw, 'utf8');
    }

    public async delete(id: string): Promise<void> {
        const file = this.filePath(id);
        if (!existsSync(file)) return;
        await unlink(file);
    }

    public async exists(id: string): Promise<boolean> {
        return existsSync(this.filePath(id));
    }

    /** Pick an id that doesn't collide with anything already on disk. */
    public uniqueId(basename: string): string {
        if (!existsSync(this.filePath(basename))) return basename;

        const dot = basename.lastIndexOf('.');
        const stem = dot === -1 ? basename : basename.slice(0, dot);
        const ext = dot === -1 ? '' : basename.slice(dot);

        for (let i = 2; i < 1000; i += 1) {
            const candidate = `${stem}-${i}${ext}`;
            if (!existsSync(this.filePath(candidate))) return candidate;
        }

        throw new Error(`could not allocate unique chat id near ${basename}`);
    }

    /**
     * Build a Note-shaped object from a chat file on disk so the existing
     * parseChatSession / summarizeChat helpers (which expect a Note) work
     * without modification.
     */
    private async readAsNote(id: string, file: string): Promise<Note | null> {
        try {
            const raw = await readFile(file, 'utf8');
            const parsed = matter(raw);
            const frontmatter = parsed.data as Frontmatter;
            const body = parsed.content;
            const stats = await stat(file);

            return {
                id,
                path: file,
                title: typeof frontmatter.title === 'string' && frontmatter.title.length > 0
                    ? frontmatter.title
                    : id,
                content: body,
                frontmatter,
                tags: Array.isArray(frontmatter.tags)
                    ? frontmatter.tags.filter((t): t is string => typeof t === 'string')
                    : [],
                wikilinks: [],
                backlinks: [],
                mtime: stats.mtimeMs,
                hash: ''
            };
        } catch {
            return null;
        }
    }
}

async function* walkMarkdown(root: string): AsyncIterableIterator<string> {
    const entries = await readdir(root, {withFileTypes: true});

    for (const entry of entries) {
        const full = path.join(root, entry.name);

        if (entry.isDirectory()) {
            yield* walkMarkdown(full);
            continue;
        }

        if (entry.isFile() && entry.name.endsWith('.md')) {
            yield full;
        }
    }
}