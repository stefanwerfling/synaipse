import type {Config, Frontmatter, Note, NoteId, NoteWriteInput, SearchHit, SearchMode, Graph, VaultEvent} from '@synaipse/core';
import {Vault, VaultWatcher} from '@synaipse/vault';
import {createEmbedder, QdrantStore, VectorIndex} from '@synaipse/vector';
import {fulltextSearch} from './Fulltext.js';
import {HashCache} from './Cache.js';

export interface IndexingStats {
    total: number;
    reindexed: number;
    removed: number;
    unchanged: number;
}

export interface RelatedNote {
    id: NoteId;
    title: string;
    score: number;
    reasons: string[];
}

export interface LinkSuggestion {
    a: NoteId;
    aTitle: string;
    b: NoteId;
    bTitle: string;
    score: number;
    reasons: string[];
    sharedTags?: string[];
}

export interface SuggestLinksOptions {
    limit?: number;
    minScore?: number;
    pathPrefix?: string;
}

export interface TodoItem {
    noteId: NoteId;
    title: string;
    line: number;
    text: string;
    done: boolean;
}

export interface UpdateNoteInput {
    content?: string;
    frontmatterPatch?: Frontmatter;
}

const TODO_REGEX = /^\s*-\s+\[([ xX])\]\s+(.+?)\s*$/;
const SEMANTIC_SAMPLE_CHARS = 1500;

export type VaultChangeListener = (event: VaultEvent & {noteId: NoteId}) => void;

export class SynaipseService {
    private readonly vault: Vault;
    private readonly index: VectorIndex | null;
    private readonly watcher: VaultWatcher;
    private readonly cache: HashCache;
    private lastStats: IndexingStats = {total: 0, reindexed: 0, removed: 0, unchanged: 0};
    private readonly vaultChangeListeners = new Set<VaultChangeListener>();

    public constructor(config: Config) {
        this.vault = new Vault(config.vaultPath);
        this.cache = new HashCache(config.indexCachePath);
        this.watcher = new VaultWatcher(config.vaultPath);

        const embedder = createEmbedder(config);

        if (embedder === null) {
            this.index = null;
            return;
        }

        const store = new QdrantStore({
            url: config.qdrant.url,
            ...(config.qdrant.apiKey !== undefined ? {apiKey: config.qdrant.apiKey} : {}),
            collection: config.qdrant.collection,
            dimension: embedder.dimension
        });

        this.index = new VectorIndex({
            embedder,
            store,
            onBatch: ({batch, batches, chunks, chars}) => {
                process.stderr.write(`[synaipse] embed batch ${batch}/${batches} (${chunks} chunks, ${chars} chars)\n`);
            },
            onOversize: (chunk) => {
                process.stderr.write(`[synaipse] WARN oversize chunk ${chunk.id} (${chunk.text.length} chars) — tune CHUNK_DEFAULTS\n`);
            }
        });
    }

    public async start(): Promise<void> {
        await Promise.all([this.vault.load(), this.cache.load()]);

        if (this.index === null) {
            process.stderr.write(`[synaipse] embeddings disabled (provider=none) — fulltext only, ${this.vault.list().length} notes loaded\n`);
            this.attachWatcher();
            return;
        }

        const stats: IndexingStats = {total: 0, reindexed: 0, removed: 0, unchanged: 0};
        const liveIds = new Set<NoteId>();
        const toReindex: Note[] = [];

        for (const note of this.vault.list()) {
            stats.total += 1;
            liveIds.add(note.id);

            const cached = this.cache.get(note.id);

            if (cached && cached.hash === note.hash) {
                stats.unchanged += 1;
                continue;
            }

            toReindex.push(note);
        }

        const orphans: NoteId[] = this.cache.ids().filter((id) => !liveIds.has(id));

        if (toReindex.length > 0) {
            await this.index.indexNotes(toReindex);

            for (const note of toReindex) {
                this.cache.set(note.id, {hash: note.hash, mtime: note.mtime});
            }

            stats.reindexed = toReindex.length;
        }

        if (orphans.length > 0) {
            await this.index.deleteNotes(orphans);

            for (const id of orphans) {
                this.cache.delete(id);
            }

            stats.removed = orphans.length;
        }

        await this.cache.flush();
        this.lastStats = stats;

        process.stderr.write(
            `[synaipse] indexed: ${stats.reindexed} reindexed, ${stats.unchanged} unchanged, ${stats.removed} removed (total ${stats.total})\n`
        );

        this.attachWatcher();
    }

    public async stop(): Promise<void> {
        await this.watcher.stop();
        await this.cache.flush();
    }

    public getLastIndexingStats(): IndexingStats {
        return this.lastStats;
    }

    public getVault(): Vault {
        return this.vault;
    }

    public hasSemanticIndex(): boolean {
        return this.index !== null;
    }

    public async search(query: string, mode: SearchMode, limit: number): Promise<SearchHit[]> {
        if (mode === 'fulltext' || this.index === null) {
            return fulltextSearch(this.vault.list(), query, limit);
        }

        if (mode === 'semantic') {
            return this.index.semanticSearch(query, limit);
        }

        const [ft, sem] = await Promise.all([
            Promise.resolve(fulltextSearch(this.vault.list(), query, limit)),
            this.index.semanticSearch(query, limit)
        ]);

        return this.mergeHits(ft, sem, limit);
    }

    public async writeNote(input: NoteWriteInput): Promise<Note> {
        const note = await this.vault.write(input);

        if (this.index !== null) {
            await this.index.indexNote(note);
        }

        this.cache.set(note.id, {hash: note.hash, mtime: note.mtime});
        return note;
    }

    public async deleteNote(id: NoteId): Promise<void> {
        await this.vault.delete(id);

        if (this.index !== null) {
            await this.index.deleteNote(id);
        }

        this.cache.delete(id);
    }

    public async appendSessionLog(summary: string, references: string[]): Promise<NoteId> {
        const now = new Date();
        const date = now.toISOString().slice(0, 10);
        const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        const sessionPath = `Memory/sessions/${date}.md`;
        const existing = this.vault.tryGet(sessionPath);

        const baseFrontmatter = existing !== undefined
            ? {...existing.frontmatter, updated: date}
            : {title: `Session ${date}`, tags: ['session', 'log'], created: date, updated: date};

        const refsLine = references.length > 0
            ? `\n\n**References:** ${references.map((r) => `[[${r}]]`).join(' · ')}`
            : '';

        const newEntry = `## ${time}\n\n${summary.trim()}${refsLine}\n`;

        const prevBody = (existing?.content ?? '').trimEnd();
        const body = prevBody.length === 0 ? newEntry : `${prevBody}\n\n${newEntry}`;

        const note = await this.writeNote({
            path: sessionPath,
            content: body,
            frontmatter: baseFrontmatter
        });

        return note.id;
    }

    public readNote(id: NoteId): Note {
        return this.vault.get(id);
    }

    public listNotes(): Note[] {
        return this.vault.list();
    }

    public tags(): Map<string, NoteId[]> {
        return this.vault.tags();
    }

    public backlinks(id: NoteId): NoteId[] {
        return this.vault.backlinksOf(id);
    }

    public onVaultChange(listener: VaultChangeListener): () => void {
        this.vaultChangeListeners.add(listener);
        return () => {
            this.vaultChangeListeners.delete(listener);
        };
    }

    public graph(): Graph {
        const notes = this.vault.list();
        const titleToId = new Map(notes.map((n) => [n.title, n.id]));

        return {
            nodes: notes.map((n) => ({id: n.id, title: n.title, tags: n.tags})),
            edges: notes.flatMap((n) =>
                n.wikilinks
                    .map((link) => titleToId.get(link))
                    .filter((target): target is NoteId => Boolean(target))
                    .map((target) => ({from: n.id, to: target, kind: 'wikilink' as const}))
            )
        };
    }

    public async related(id: NoteId, limit = 10): Promise<RelatedNote[]> {
        const note = this.vault.tryGet(id);

        if (note === undefined) {
            return [];
        }

        const accumulator = new Map<NoteId, {score: number; reasons: Set<string>}>();

        const add = (otherId: NoteId, weight: number, reason: string): void => {
            if (otherId === id || weight <= 0) {
                return;
            }

            const entry = accumulator.get(otherId) ?? {score: 0, reasons: new Set<string>()};
            entry.score += weight;
            entry.reasons.add(reason);
            accumulator.set(otherId, entry);
        };

        if (this.index !== null && note.content.length > 0) {
            const sample = note.content.slice(0, SEMANTIC_SAMPLE_CHARS);
            const hits = await this.index.semanticSearch(sample, limit * 2);

            for (const hit of hits) {
                add(hit.noteId, hit.score, 'semantic');
            }
        }

        const titleToId = new Map<string, NoteId>();
        for (const other of this.vault.list()) {
            titleToId.set(other.title, other.id);
        }

        for (const link of note.wikilinks) {
            const targetId = titleToId.get(link);

            if (targetId !== undefined) {
                add(targetId, 0.6, 'wikilink-out');
            }
        }

        for (const backlinkId of this.backlinks(id)) {
            add(backlinkId, 0.6, 'wikilink-in');
        }

        const myTags = new Set(note.tags);

        if (myTags.size > 0) {
            for (const other of this.vault.list()) {
                if (other.id === id) {
                    continue;
                }

                const shared = other.tags.filter((t) => myTags.has(t));

                if (shared.length === 0) {
                    continue;
                }

                if (shared.length >= 2) {
                    add(other.id, shared.length * 0.25, `tags:${shared.join(',')}`);
                } else {
                    add(other.id, 0.12, `tag:${shared[0] ?? ''}`);
                }
            }
        }

        return [...accumulator.entries()]
            .map(([otherId, {score, reasons}]) => {
                const other = this.vault.tryGet(otherId);
                return {
                    id: otherId,
                    title: other?.title ?? otherId,
                    score,
                    reasons: [...reasons]
                };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    public async suggestLinks(opts: SuggestLinksOptions = {}): Promise<LinkSuggestion[]> {
        const limit = opts.limit ?? 20;
        const minScore = opts.minScore ?? 0.65;
        const prefix = opts.pathPrefix ?? '';

        const allNotes = this.vault.list();
        const scoped = prefix.length === 0
            ? allNotes
            : allNotes.filter((n) => n.id.startsWith(prefix));

        if (scoped.length < 2) {
            return [];
        }

        const titleToId = new Map<string, NoteId>();
        for (const note of allNotes) {
            titleToId.set(note.title, note.id);
        }

        const linkedSet = (note: Note): Set<NoteId> => {
            const set = new Set<NoteId>([note.id]);

            for (const link of note.wikilinks) {
                const targetId = titleToId.get(link);

                if (targetId !== undefined) {
                    set.add(targetId);
                }
            }

            for (const backlinkId of this.vault.backlinksOf(note.id)) {
                set.add(backlinkId);
            }

            return set;
        };

        const suggestions = new Map<string, LinkSuggestion>();
        const pairKey = (x: NoteId, y: NoteId): string => x < y ? `${x}|${y}` : `${y}|${x}`;

        const recordPair = (
            aId: NoteId,
            bId: NoteId,
            score: number,
            reason: string,
            sharedTags?: string[]
        ): void => {
            const a = this.vault.tryGet(aId);
            const b = this.vault.tryGet(bId);

            if (a === undefined || b === undefined) {
                return;
            }

            const key = pairKey(aId, bId);
            const existing = suggestions.get(key);

            if (existing !== undefined) {
                if (score > existing.score) {
                    existing.score = score;
                }

                if (!existing.reasons.includes(reason)) {
                    existing.reasons.push(reason);
                }

                if (sharedTags !== undefined && existing.sharedTags === undefined) {
                    existing.sharedTags = sharedTags;
                }

                return;
            }

            suggestions.set(key, {
                a: aId,
                aTitle: a.title,
                b: bId,
                bTitle: b.title,
                score,
                reasons: [reason],
                ...(sharedTags !== undefined ? {sharedTags} : {})
            });
        };

        if (this.index !== null) {
            for (const note of scoped) {
                if (note.content.length === 0) {
                    continue;
                }

                const linked = linkedSet(note);
                const sample = note.content.slice(0, SEMANTIC_SAMPLE_CHARS);
                const hits = await this.index.semanticSearch(sample, 20);
                const seen = new Set<NoteId>();

                for (const hit of hits) {
                    if (seen.has(hit.noteId)) {
                        continue;
                    }

                    seen.add(hit.noteId);

                    if (linked.has(hit.noteId)) {
                        continue;
                    }

                    if (hit.score < minScore) {
                        continue;
                    }

                    if (prefix.length > 0 && !hit.noteId.startsWith(prefix)) {
                        continue;
                    }

                    recordPair(note.id, hit.noteId, hit.score, 'semantic');
                }
            }
        }

        for (let i = 0; i < scoped.length; i++) {
            const a = scoped[i];

            if (a === undefined || a.tags.length < 2) {
                continue;
            }

            const aLinked = linkedSet(a);
            const aTagSet = new Set(a.tags);

            for (let j = i + 1; j < scoped.length; j++) {
                const b = scoped[j];

                if (b === undefined || aLinked.has(b.id)) {
                    continue;
                }

                const shared = b.tags.filter((t) => aTagSet.has(t));

                if (shared.length < 2) {
                    continue;
                }

                const score = Math.min(0.95, 0.5 + 0.1 * shared.length);
                recordPair(a.id, b.id, score, 'tag-overlap', shared);
            }
        }

        return [...suggestions.values()]
            .sort((x, y) => y.score - x.score)
            .slice(0, limit);
    }

    public todos(pathPrefix = '', includeDone = false): TodoItem[] {
        const result: TodoItem[] = [];

        for (const note of this.vault.list()) {
            if (pathPrefix.length > 0 && !note.id.startsWith(pathPrefix)) {
                continue;
            }

            const lines = note.content.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i] ?? '';
                const match = TODO_REGEX.exec(line);

                if (match === null) {
                    continue;
                }

                const done = match[1] !== ' ';

                if (done && !includeDone) {
                    continue;
                }

                result.push({
                    noteId: note.id,
                    title: note.title,
                    line: i + 1,
                    text: (match[2] ?? '').trim(),
                    done
                });
            }
        }

        return result;
    }

    public async linkNote(fromId: NoteId, toTitles: readonly string[], section = 'References'): Promise<{note: Note; added: string[]}> {
        const note = this.vault.get(fromId);
        const targets = toTitles.map((t) => t.trim()).filter((t) => t.length > 0);

        if (targets.length === 0) {
            return {note, added: []};
        }

        const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const headingPattern = new RegExp(`^##\\s+${escapedSection}\\s*$`);
        const lines = note.content.split('\n');

        let sectionStart = -1;
        let sectionEnd = lines.length;

        for (let i = 0; i < lines.length; i++) {
            if (headingPattern.test(lines[i] ?? '')) {
                sectionStart = i;

                for (let j = i + 1; j < lines.length; j++) {
                    if (/^##\s/.test(lines[j] ?? '')) {
                        sectionEnd = j;
                        break;
                    }
                }
                break;
            }
        }

        let body: string;
        let added: string[];

        if (sectionStart === -1) {
            added = [...targets];
            const insertion = added.map((t) => `- [[${t}]]`).join('\n');
            const trimmed = note.content.replace(/\s+$/, '');
            const sep = trimmed.length === 0 ? '' : '\n\n';
            body = `${trimmed}${sep}## ${section}\n\n${insertion}\n`;
        } else {
            const sectionLines = lines.slice(sectionStart, sectionEnd);
            const existing = new Set<string>();
            const linkPattern = /\[\[([^\]]+)\]\]/g;

            for (const ln of sectionLines) {
                let match: RegExpExecArray | null;

                while ((match = linkPattern.exec(ln)) !== null) {
                    existing.add(match[1] ?? '');
                }
            }

            added = targets.filter((t) => !existing.has(t));

            if (added.length === 0) {
                return {note, added: []};
            }

            const insertion = added.map((t) => `- [[${t}]]`);
            const newLines = [...lines.slice(0, sectionEnd), ...insertion, ...lines.slice(sectionEnd)];
            body = newLines.join('\n');
        }

        const updated = await this.writeNote({
            path: note.id,
            content: body,
            frontmatter: note.frontmatter
        });

        return {note: updated, added};
    }

    public async updateNote(id: NoteId, patch: UpdateNoteInput): Promise<Note> {
        const existing = this.vault.get(id);
        const nextContent = patch.content ?? existing.content;
        const nextFrontmatter = patch.frontmatterPatch === undefined
            ? existing.frontmatter
            : {...existing.frontmatter, ...patch.frontmatterPatch};

        return this.writeNote({
            path: existing.id,
            content: nextContent,
            frontmatter: nextFrontmatter
        });
    }

    private attachWatcher(): void {
        this.watcher.on('event', (event) => {
            this.handleEvent(event.kind, event.path).catch((error: unknown) => {
                process.stderr.write(`[synaipse] watcher error: ${String(error)}\n`);
            });
        });

        this.watcher.start();
    }

    private async handleEvent(kind: 'created' | 'updated' | 'deleted', path: string): Promise<void> {
        await this.vault.handleExternalChange(path, kind);
        const id = this.idFromPath(path);

        if (kind === 'deleted') {
            if (this.index !== null) {
                await this.index.deleteNote(id);
            }
            this.cache.delete(id);
            this.notifyVaultChange({kind, path, noteId: id});
            return;
        }

        const note = this.vault.tryGet(id);

        if (!note) {
            return;
        }

        const cached = this.cache.get(id);

        if (cached && cached.hash === note.hash) {
            return;
        }

        if (this.index !== null) {
            await this.index.indexNote(note);
        }

        this.cache.set(id, {hash: note.hash, mtime: note.mtime});
        this.notifyVaultChange({kind, path, noteId: id});
    }

    private notifyVaultChange(event: VaultEvent & {noteId: NoteId}): void {
        for (const listener of this.vaultChangeListeners) {
            try {
                listener(event);
            } catch (error) {
                process.stderr.write(`[synaipse] vault-change listener error: ${String(error)}\n`);
            }
        }
    }

    private idFromPath(absolutePath: string): NoteId {
        return absolutePath
            .replace(this.vault.root, '')
            .replace(/^[\\/]/, '')
            .replaceAll('\\', '/');
    }

    private mergeHits(a: SearchHit[], b: SearchHit[], limit: number): SearchHit[] {
        const map = new Map<NoteId, SearchHit>();

        const add = (hit: SearchHit, weight: number): void => {
            const prev = map.get(hit.noteId);

            if (!prev) {
                map.set(hit.noteId, {...hit, score: hit.score * weight});
                return;
            }

            prev.score += hit.score * weight;
        };

        for (const hit of a) add(hit, 1);
        for (const hit of b) add(hit, 1.2);

        return [...map.values()].sort((x, y) => y.score - x.score).slice(0, limit);
    }
}