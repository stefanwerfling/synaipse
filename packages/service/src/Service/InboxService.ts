import type {Note, NoteId} from '@synaipse/core';
import {isInboxNote, parseInbox, withoutInboxEntry, type InboxEntry} from '../Inbox.js';
import type {NoteCore} from './NoteCore.js';
import type {NoteWriter} from './NoteWriter.js';
import type {ProjectScope} from './ProjectScope.js';
import type {SearchService} from './SearchService.js';
import type {InboxCandidate, InboxEntryRef, InboxTarget} from './Types.js';

/**
 * The remember inbox per project (plan P8 / C5): list entries, move one
 * into a curated note or discard it, and propose where entries belong.
 */
export class InboxService {
    public constructor(
        private readonly core: NoteCore,
        private readonly writer: NoteWriter,
        private readonly searchService: SearchService,
        private readonly scope: ProjectScope
    ) {}

    private get notes(): NoteCore['notes'] {
        return this.core.notes;
    }

    /** Projects with entries in their remember inbox, most entries first. */
    public list(): Array<{project: string; entries: number}> {
        const counts = new Map<string, number>();
        for (const note of this.notes.list()) {
            const m = /^Memory\/([^/]+)\/inbox\//.exec(note.id);
            if (m === null || !isInboxNote(note.id)) continue;
            const n = parseInbox(note.id, note.content).length;
            if (n > 0) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + n);
        }
        return [...counts].map(([project, entries]) => ({project, entries})).sort((a, b) => b.entries - a.entries || a.project.localeCompare(b.project));
    }

    /** Inbox entries of a project, newest day first (entries in file order). */
    public entries(project: string, opts: {sinceMs?: number} = {}): InboxEntry[] {
        const prefix = `${this.scope.folder(project)}inbox/`;
        const since = opts.sinceMs === undefined ? null : new Date(opts.sinceMs).toISOString().slice(0, 10);

        return this.notes.list()
            .filter((n) => n.id.startsWith(prefix) && isInboxNote(n.id))
            .flatMap((n) => parseInbox(n.id, n.content))
            .filter((e) => since === null || e.date >= since)
            .sort((a, b) => b.date.localeCompare(a.date));
    }

    /**
     * Remove one inbox entry (plan P8 / C5 "Verwerfen"). An inbox note
     * without entries left is deleted; both are versioned like any write.
     */
    public async discard(project: string, ref: InboxEntryRef): Promise<void> {
        const inbox = this.inboxNote(project, ref.inbox);
        const rest = withoutInboxEntry(inbox.id, inbox.content, ref.time, ref.text);
        if (rest === null) throw new Error(`inbox entry ${ref.time} not found in ${ref.inbox} (changed meanwhile?)`);

        const opts = {project};
        if (parseInbox(inbox.id, rest).length === 0) {
            await this.writer.deleteNote(inbox.id, opts);
            return;
        }
        await this.writer.writeNote({path: inbox.id, content: rest, frontmatter: inbox.frontmatter, expectedHash: inbox.hash}, opts, 'inbox_discard');
    }

    /**
     * Move one inbox entry into a curated note (plan P8 / C5 "In Note
     * übernehmen"): `text` (default the entry's own) is appended to the
     * target, or becomes the body of a new note, then the entry leaves
     * the inbox. Returns the target note.
     */
    public async promote(project: string, ref: InboxEntryRef, target: InboxTarget, text?: string): Promise<Note> {
        const inbox = this.inboxNote(project, ref.inbox);
        if (withoutInboxEntry(inbox.id, inbox.content, ref.time, ref.text) === null) {
            throw new Error(`inbox entry ${ref.time} not found in ${ref.inbox} (changed meanwhile?)`);
        }

        const body = (text ?? ref.text).trim();
        if (body.length === 0) throw new Error('promote: text must not be empty');
        const opts = {project};
        let note: Note;

        if ('id' in target) {
            const existing = this.notes.tryGet(target.id);
            if (existing === undefined) throw new Error(`target note not found: ${target.id}`);
            if (isInboxNote(existing.id)) throw new Error('target must not be an inbox note');
            note = await this.writer.writeNote({
                path: existing.id,
                content: `${existing.content.trimEnd()}\n\n${body}\n`,
                frontmatter: existing.frontmatter,
                expectedHash: existing.hash
            }, opts, 'inbox_promote');
        } else {
            const title = target.newTitle.trim();
            if (title.length === 0) throw new Error('promote: a new note needs a title');
            const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'note';
            note = await this.writer.writeNote({
                path: target.newPath?.trim() || `${slug}.md`,
                content: `${body}\n`,
                frontmatter: {title, created: new Date().toISOString().slice(0, 10)},
                mode: 'create'
            }, opts, 'inbox_promote');
        }

        // Reads the inbox afresh, so a remember in between is kept.
        await this.discard(project, ref);
        return note;
    }

    private inboxNote(project: string, id: NoteId): Note {
        if (!id.startsWith(`${this.scope.folder(project)}inbox/`) || !isInboxNote(id)) {
            throw new Error(`not an inbox note of project ${project}: ${id}`);
        }
        const note = this.notes.tryGet(id);
        if (note === undefined) throw new Error(`inbox note not found: ${id}`);
        return note;
    }

    /**
     * Consolidation candidates for the inbox (plan P8 / B4): per entry the
     * notes that already hold it and the curated notes to merge it into.
     * Synaipse only proposes; the agent (or the user in the UI) writes.
     */
    public async candidates(project: string, opts: {sinceMs?: number; limit?: number} = {}): Promise<InboxCandidate[]> {
        const entries = this.entries(project, opts).slice(0, opts.limit ?? 30);
        const out: InboxCandidate[] = [];

        for (const entry of entries) {
            const alreadyIn = await this.searchService.possibleDuplicates({title: '', content: entry.text}, [entry.inbox]);
            const known = new Set(alreadyIn.map((d) => d.id));
            const hits = await this.searchService.search(entry.text, 'hybrid', 8);
            const targets = hits
                .filter((h) => !isInboxNote(h.noteId) && !known.has(h.noteId) && h.noteId !== entry.inbox)
                .slice(0, 3)
                .map((h) => ({id: h.noteId, title: h.title}));

            out.push({...entry, alreadyIn, targets});
        }

        return out;
    }
}
