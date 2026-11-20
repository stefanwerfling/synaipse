import type {Note, NoteId} from '@synaipse/core';
import {isOutdated, knowledgeStateOf} from '../KnowledgeState.js';
import {archivePathFor, findDecayCandidates, type DecayOptions} from '../MemoryDecay.js';
import type {NoteCore} from './NoteCore.js';
import type {NoteWriter} from './NoteWriter.js';
import type {ProjectScope} from './ProjectScope.js';
import type {SearchService} from './SearchService.js';
import type {ArchiveReport, PrimeOptions, PrimeResult, PrimerEntry, PrimerReason, ProjectOpts, StaleNote, StaleNotesOptions, TodoItem} from './Types.js';
import {buildCommitMessage, extractExcerpt, MS_PER_DAY} from './Util.js';

const TODO_REGEX = /^\s*-\s+\[([ xX])\]\s+(.+?)\s*$/;

/** Checkbox lines of one note, open and done. */
const parseTodos = (note: Note): TodoItem[] => {
    const result: TodoItem[] = [];
    const lines = note.content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const match = TODO_REGEX.exec(lines[i] ?? '');

        if (match !== null) {
            result.push(Object.freeze({
                noteId: note.id,
                title: note.title,
                line: i + 1,
                text: (match[2] ?? '').trim(),
                done: match[1] !== ' '
            }));
        }
    }

    return result;
};

/**
 * Agent memory: the session log and the remember inbox (writes), the
 * primer for a new session, open todos, and decay (stale notes and
 * archiving them).
 */
export class MemoryService {
    public constructor(
        private readonly core: NoteCore,
        private readonly writer: NoteWriter,
        private readonly searchService: SearchService,
        private readonly scope: ProjectScope
    ) {}

    /** Parsed todos per note, reused while title and content are unchanged (plan A1). */
    private readonly todosByNote = new Map<NoteId, {title: string; content: string; items: readonly TodoItem[]}>();
    /** All todos (open and done) of one note list, see {@link allTodos}. */
    private todoSnapshot: {list: readonly Note[]; items: readonly TodoItem[]} | null = null;

    private get notes(): NoteCore['notes'] {
        return this.core.notes;
    }

    public async appendSessionLog(summary: string, references: string[], opts?: ProjectOpts): Promise<NoteId> {
        const project = this.scope.require('log_session', opts?.project);
        const now = new Date();
        const date = now.toISOString().slice(0, 10);
        const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        const sessionPath = `${this.scope.folder(project)}sessions/${date}.md`;
        const existing = this.notes.tryGet(sessionPath);

        const baseFrontmatter = existing !== undefined
            ? {...existing.frontmatter, updated: date}
            : {title: `Session ${date}`, tags: ['session', 'log'], created: date, updated: date};

        const refsLine = references.length > 0
            ? `\n\n**References:** ${references.map((r) => `[[${r}]]`).join(' · ')}`
            : '';

        const newEntry = `## ${time}\n\n${summary.trim()}${refsLine}\n`;

        const prevBody = (existing?.content ?? '').trimEnd();
        const body = prevBody.length === 0 ? newEntry : `${prevBody}\n\n${newEntry}`;

        const note = await this.writer.writeNote(
            {path: sessionPath, content: body, frontmatter: baseFrontmatter},
            opts,
            'log_session'
        );

        // References are an explicit "Claude actually used this" signal —
        // distinct from touchAccess, which fires on every retrieval
        // regardless of relevance. Record it against whichever note the
        // title/alias resolves to; unresolved titles (typos, notes that
        // don't exist yet) still get written as a wikilink above but don't
        // bump anything here.
        if (references.length > 0) {
            // Resolved like the [[reference]] written above: title before alias (plan A1: cached map, no rescan).
            const keys = this.core.linkKeyMap();

            for (const reference of references) {
                const targetId = keys.get(reference);
                const target = targetId === undefined ? undefined : this.notes.tryGet(targetId);

                if (target !== undefined) {
                    // Seed hash/mtime like touchAccess does — a note that's
                    // never been read/searched has no cache entry yet, and
                    // recordReference() without a seed is a no-op.
                    this.notes.recordReference(target.id, target.hash, target.mtime);
                }
            }
        }

        return note.id;
    }

    public async appendInboxEntry(text: string, tags: string[], opts?: ProjectOpts): Promise<NoteId> {
        const project = this.scope.require('remember', opts?.project);
        const trimmed = text.trim();

        if (trimmed.length === 0) {
            throw new Error('remember: text must not be empty');
        }

        const now = new Date();
        const date = now.toISOString().slice(0, 10);
        const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        const inboxPath = `${this.scope.folder(project)}inbox/${date}.md`;
        const existing = this.notes.tryGet(inboxPath);

        const baseFrontmatter = existing !== undefined
            ? {...existing.frontmatter, updated: date}
            : {title: `Inbox ${date}`, tags: ['inbox'], created: date, updated: date};

        const cleanTags = tags
            .map((t) => t.trim().replace(/^#/, ''))
            .filter((t) => t.length > 0);
        const tagsLine = cleanTags.length > 0
            ? `\n\n${cleanTags.map((t) => `#${t}`).join(' ')}`
            : '';

        const newEntry = `### ${time}\n\n${trimmed}${tagsLine}\n`;

        const prevBody = (existing?.content ?? '').trimEnd();
        const body = prevBody.length === 0 ? newEntry : `${prevBody}\n\n${newEntry}`;

        const note = await this.writer.writeNote(
            {path: inboxPath, content: body, frontmatter: baseFrontmatter},
            opts,
            'remember'
        );

        return note.id;
    }

    public staleNotes(opts: StaleNotesOptions = {}, now: number = Date.now()): StaleNote[] {
        const olderThanDays = opts.olderThanDays ?? 90;
        const pathPrefix = opts.pathPrefix ?? '';
        const limit = opts.limit ?? 100;
        const thresholdMs = olderThanDays * MS_PER_DAY;

        const result: StaleNote[] = [];

        for (const note of this.notes.list()) {
            if (pathPrefix.length > 0 && !note.id.startsWith(pathPrefix)) {
                continue;
            }

            const entry = this.notes.getEntry(note.id);
            const lastAccessed = entry?.lastAccessed;
            const accessCount = entry?.accessCount ?? 0;
            const lastReferenced = entry?.lastReferenced;
            const referencedCount = entry?.referencedCount ?? 0;

            // lastReferenced (explicit "Claude actually used this" from
            // log_session) counts toward freshness alongside lastAccessed
            // (mere retrieval) — a note cited in session outcomes isn't
            // stale even if nobody has edited or merely searched it lately.
            const effective = Math.max(
                note.mtime,
                lastAccessed ?? 0,
                lastReferenced ?? 0
            );

            const ageMs = now - effective;

            if (ageMs < thresholdMs) {
                continue;
            }

            result.push({
                id: note.id,
                title: note.title,
                tags: note.tags,
                mtime: note.mtime,
                ...(lastAccessed !== undefined ? {lastAccessed} : {}),
                accessCount,
                ...(lastReferenced !== undefined ? {lastReferenced} : {}),
                referencedCount,
                ageDays: Math.floor(ageMs / MS_PER_DAY)
            });
        }

        return result.sort((a, b) => b.ageDays - a.ageDays).slice(0, limit);
    }

    /**
     * Find notes that have decayed (no backlinks, no tags, mtime older than N
     * days, not pinned, not prime, not already archived) and move them to
     * `<archivePrefix><original-id>`. Dry-run returns the candidate list
     * without touching the vault.
     *
     * Move = writeNote(archive-path) + deleteNote(original). Wikilinks
     * resolve by title/alias, not by path, so outgoing links survive the
     * move. Incoming links can't break because candidates have zero backlinks
     * by definition.
     */
    public async archiveStaleNotes(
        opts: DecayOptions & {dryRun?: boolean} = {},
        now: number = Date.now()
    ): Promise<ArchiveReport> {
        const archivePrefix = opts.archivePrefix ?? 'Archive/';
        const dryRun = opts.dryRun === true;

        const candidates = findDecayCandidates(
            this.notes.list(),
            now,
            opts,
            (id) => {
                const entry = this.notes.getEntry(id);
                return entry === undefined
                    ? undefined
                    : {
                        ...(entry.lastAccessed !== undefined ? {lastAccessed: entry.lastAccessed} : {}),
                        ...(entry.lastReferenced !== undefined ? {lastReferenced: entry.lastReferenced} : {})
                    };
            }
        );
        const archived: NoteId[] = [];
        const failed: Array<{id: NoteId; error: string}> = [];

        if (dryRun) {
            return {candidates, archived, failed, dryRun: true};
        }

        for (const candidate of candidates) {
            const note = this.notes.tryGet(candidate.id);

            if (note === undefined) {
                failed.push({id: candidate.id, error: 'note vanished mid-run'});
                continue;
            }

            const destination = archivePathFor(candidate.id, archivePrefix);

            try {
                await this.notes.write(
                    {path: destination, content: note.content, frontmatter: note.frontmatter},
                    {message: buildCommitMessage('archive_stale', destination, this.scope.defaultProject)}
                );

                await this.notes.delete(candidate.id, {
                    message: buildCommitMessage('archive_stale', candidate.id, this.scope.defaultProject)
                });

                await this.core.removeIndexed(candidate.id);

                const moved = this.notes.tryGet(destination);
                if (moved !== undefined) {
                    await this.core.indexWritten(moved);
                }

                archived.push(candidate.id);
            } catch (cause) {
                failed.push({id: candidate.id, error: String(cause)});
            }
        }

        if (archived.length > 0) {
            this.core.invalidateTopology();
        }

        return {candidates, archived, failed, dryRun: false};
    }

    public todos(pathPrefix = '', includeDone = false): TodoItem[] {
        return this.allTodos().filter((t) =>
            (includeDone || !t.done) && (pathPrefix.length === 0 || t.noteId.startsWith(pathPrefix)));
    }

    /**
     * Every checkbox in the vault, in note-list order. Between writes the
     * adapter hands out the same list and this is one lookup; after a write
     * only the changed notes are parsed again.
     */
    private allTodos(): readonly TodoItem[] {
        const list = this.notes.list();

        if (this.todoSnapshot?.list === list) {
            return this.todoSnapshot.items;
        }

        const items: TodoItem[] = [];

        for (const note of list) {
            let cached = this.todosByNote.get(note.id);

            if (cached === undefined || cached.content !== note.content || cached.title !== note.title) {
                cached = {title: note.title, content: note.content, items: parseTodos(note)};
                this.todosByNote.set(note.id, cached);
            }

            for (const item of cached.items) {
                items.push(item);
            }
        }

        if (this.todosByNote.size > list.length) {
            const live = new Set(list.map((n) => n.id));
            for (const id of this.todosByNote.keys()) {
                if (!live.has(id)) this.todosByNote.delete(id);
            }
        }

        this.todoSnapshot = {list, items};
        return items;
    }

    public async prime(opts: PrimeOptions = {}): Promise<PrimeResult> {
        const project = this.scope.get(opts.project ?? null);
        const limit = Math.max(1, opts.limit ?? 15);
        const topic = (opts.topic ?? '').trim();
        const includeCrawler = opts.includeCrawler === true;

        const projectPrefix = project === null ? null : `Memory/${project}/`;
        const sessionPrefix = project === null ? 'Memory/sessions/' : `Memory/${project}/sessions/`;
        const decisionPrefix = project === null ? 'Memory/decisions/' : `Memory/${project}/decisions/`;

        const all = this.notes.list();

        const isCrawler = (note: Note): boolean => note.id.startsWith('Crawler/');

        const inProject = (note: Note): boolean => {
            if (projectPrefix === null) return true;
            if (note.id.startsWith(projectPrefix)) return true;
            if (note.frontmatter['project'] === project) return true;
            if (note.tags.includes(`project/${project}`)) return true;
            return false;
        };

        const seen = new Set<NoteId>();
        const context: PrimerEntry[] = [];

        const successors = this.core.successors();
        const now = Date.now();

        const push = (note: Note, reason: PrimerReason): void => {
            if (seen.has(note.id)) return;
            // Superseded or expired knowledge stays out of the primer unless pinned.
            if (reason !== 'pinned' && isOutdated(knowledgeStateOf(note, successors, now))) return;
            seen.add(note.id);
            context.push({
                id: note.id,
                title: note.title,
                reason,
                excerpt: extractExcerpt(note.content, 240),
                tags: note.tags,
                mtime: note.mtime,
                backlinkCount: note.backlinks.length,
                referencedCount: this.notes.getEntry(note.id)?.referencedCount ?? 0
            });
        };

        for (const note of all) {
            if (note.frontmatter['prime'] === true || note.frontmatter['pinned'] === true) {
                push(note, 'pinned');
            }
        }

        const sessions = all
            .filter((n) => n.id.startsWith(sessionPrefix))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 2);
        for (const n of sessions) {
            if (context.length >= limit) break;
            push(n, 'recent_session');
        }

        const decisions = all
            .filter((n) => n.id.startsWith(decisionPrefix))
            .sort((a, b) => b.mtime - a.mtime);
        for (const n of decisions) {
            if (context.length >= limit) break;
            push(n, 'project_decision');
        }

        if (topic.length > 0) {
            // Topic always passes Crawler through — if the user asked for a topic
            // explicitly, they want hits. Filtering Crawler here would silently drop
            // legitimate code-crawler results (e.g. Crawler/code/<project>/...).
            const hits = await this.searchService.search(topic, 'hybrid', 5);
            for (const hit of hits) {
                if (context.length >= limit) break;
                const note = this.notes.tryGet(hit.noteId);
                if (note === undefined) continue;
                if (!inProject(note)) continue;
                push(note, 'topic');
            }
        }

        const projectNotes = all.filter((n) => inProject(n) && (includeCrawler || !isCrawler(n)));

        // Notes Claude explicitly cited as useful via log_session — real
        // evidence of usefulness, not just link topology (hot, below) or
        // edit recency. Ranked ahead of hot for that reason.
        const referenced = [...projectNotes]
            .filter((n) => (this.notes.getEntry(n.id)?.referencedCount ?? 0) > 0)
            .sort((a, b) =>
                (this.notes.getEntry(b.id)?.referencedCount ?? 0) - (this.notes.getEntry(a.id)?.referencedCount ?? 0))
            .slice(0, 3);
        for (const n of referenced) {
            if (context.length >= limit) break;
            push(n, 'referenced');
        }

        const hot = [...projectNotes]
            .filter((n) => n.backlinks.length > 0)
            .sort((a, b) => b.backlinks.length - a.backlinks.length)
            .slice(0, 3);
        for (const n of hot) {
            if (context.length >= limit) break;
            push(n, 'hot');
        }

        const cutoff = Date.now() - 14 * MS_PER_DAY;
        const recent = [...projectNotes]
            .filter((n) => n.mtime >= cutoff)
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 5);
        for (const n of recent) {
            if (context.length >= limit) break;
            push(n, 'recent');
        }

        const todoPrefix = projectPrefix ?? '';
        const todoSource = this.todos(todoPrefix, false);
        const allTodos = includeCrawler ? todoSource : todoSource.filter((t) => !t.noteId.startsWith('Crawler/'));

        const todoSample = allTodos.slice(0, 3);
        const payloadChars = JSON.stringify({context, todoSample}).length;

        return {
            project,
            todoCount: allTodos.length,
            todoSample,
            context,
            tokenEstimate: Math.ceil(payloadChars / 4)
        };
    }
}
