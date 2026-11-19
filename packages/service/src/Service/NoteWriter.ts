import type {Note, NoteId, NoteWriteInput} from '@synaipse/core';
import {WriteConflictError} from '@synaipse/core';
import type {NoteCore} from './NoteCore.js';
import type {ProjectScope} from './ProjectScope.js';
import type {ProjectOpts, UpdateNoteInput, WriteGuard} from './Types.js';
import {buildCommitMessage} from './Util.js';

/**
 * Every note write and delete goes through here: project scoping for
 * MCP writers, write guards with a per-path lock, the commit message,
 * and indexing afterwards.
 */
export class NoteWriter {
    /** Tail of the pending writes per path (see withPathLock). */
    private readonly pathLocks = new Map<string, Promise<void>>();

    public constructor(
        private readonly core: NoteCore,
        private readonly scope: ProjectScope
    ) {}

    public async writeNote(input: NoteWriteInput & WriteGuard, opts?: ProjectOpts, commitTool = 'write_note'): Promise<Note> {
        const project = this.scope.require('write_note', opts?.project);
        const extraTags = this.scope.resolveExtraTags(opts?.extraTags);

        const scoped: NoteWriteInput = {
            path: this.scope.normaliseWritePath(input.path, project),
            content: input.content,
            frontmatter: this.scope.applyToFrontmatter(input.frontmatter, project, extraTags)
        };

        // Guard check and write under one per-path lock, so two writers
        // holding the same expectedHash cannot both succeed.
        return this.withPathLock(scoped.path, async () => {
            this.checkWriteGuard(scoped.path, input);

            const note = await this.core.notes.write(scoped, {
                message: buildCommitMessage(commitTool, scoped.path, project),
                ...(opts?.gitAuthor !== undefined ? {author: opts.gitAuthor} : {})
            });

            await this.core.indexWritten(note);
            return note;
        });
    }

    /** The note id a scoped write of `path` lands on (project folder prefix applied). */
    public writePathFor(path: string, opts?: ProjectOpts): NoteId {
        return this.scope.normaliseWritePath(path, this.scope.require('write_note', opts?.project));
    }

    private checkWriteGuard(path: NoteId, guard: WriteGuard): void {
        const current = this.core.notes.tryGet(path);
        const mode = guard.mode ?? 'upsert';

        if (mode === 'create' && current !== undefined) {
            throw new WriteConflictError(
                `${path} already exists (hash ${current.hash}). Read it and change it with edit_note/update_note, or write with mode "upsert".`,
                path, current.hash);
        }

        if (mode === 'overwrite' && current === undefined) {
            throw new WriteConflictError(`${path} does not exist; nothing to overwrite. Write with mode "create" or "upsert".`, path, null);
        }

        if (guard.expectedHash !== undefined && current?.hash !== guard.expectedHash) {
            throw new WriteConflictError(
                current === undefined
                    ? `${path} does not exist (expectedHash ${guard.expectedHash}).`
                    : `${path} changed since you read it (expected hash ${guard.expectedHash}, now ${current.hash}). Read it again and reapply your change.`,
                path, current?.hash ?? null);
        }
    }

    /** Run `fn` after every earlier call for the same path has settled. */
    private async withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.pathLocks.get(path) ?? Promise.resolve();
        const run = previous.then(fn, fn);
        const settled = run.then(() => undefined, () => undefined);
        this.pathLocks.set(path, settled);

        try {
            return await run;
        } finally {
            if (this.pathLocks.get(path) === settled) this.pathLocks.delete(path);
        }
    }

    /**
     * Unscoped write for the web UI (a single-user vault editor): any
     * path, no project prefix, no injected `project/<name>` tag. MCP
     * writers must NOT use this, so per-token ACLs and folder isolation
     * stay intact.
     */
    public async writeNoteUnscoped(input: NoteWriteInput, commitTool = 'write_note'): Promise<Note> {
        return this.writeRaw(input, buildCommitMessage(commitTool, input.path, null));
    }

    /** Write with a ready commit message (compile, relink, clip, import) and index the result. */
    public async writeRaw(input: NoteWriteInput, message: string): Promise<Note> {
        const note = await this.core.notes.write(input, {message});
        await this.core.indexWritten(note);
        return note;
    }

    public async deleteNote(id: NoteId, opts?: ProjectOpts): Promise<void> {
        this.scope.assertInProject(id, 'delete_note', opts?.project);

        const project = this.scope.get(opts?.project);
        await this.core.notes.delete(id, {
            message: buildCommitMessage('delete_note', id, project),
            ...(opts?.gitAuthor !== undefined ? {author: opts.gitAuthor} : {})
        });

        await this.core.removeIndexed(id);
        this.core.invalidateTopology();
    }

    /** Unscoped counterpart to {@link deleteNote}; same MCP-vs-web split as {@link writeNoteUnscoped}. */
    public async deleteNoteUnscoped(id: NoteId): Promise<void> {
        await this.core.notes.delete(id, {
            message: buildCommitMessage('delete_note', id, null)
        });

        await this.core.removeIndexed(id);
        this.core.invalidateTopology();
    }

    public async updateNote(id: NoteId, patch: UpdateNoteInput, opts?: ProjectOpts): Promise<Note> {
        this.scope.assertInProject(id, 'update_note', opts?.project);
        const existing = this.core.notes.get(id);

        if (patch.expectedHash !== undefined && existing.hash !== patch.expectedHash) {
            throw new WriteConflictError(
                `${id} changed since you read it (expected hash ${patch.expectedHash}, now ${existing.hash}). Read it again and reapply your change.`,
                id, existing.hash);
        }
        const nextContent = patch.content ?? existing.content;
        const nextFrontmatter = patch.frontmatterPatch === undefined
            ? existing.frontmatter
            : {...existing.frontmatter, ...patch.frontmatterPatch};

        return this.writeNote(
            {path: existing.id, content: nextContent, frontmatter: nextFrontmatter, ...(patch.expectedHash !== undefined ? {expectedHash: patch.expectedHash} : {})},
            opts,
            'update_note'
        );
    }

    /** Append `[[title]]` links under a `## <section>` heading (created when missing), skipping links already there. */
    public async linkNote(fromId: NoteId, toTitles: readonly string[], section = 'References', opts?: ProjectOpts): Promise<{note: Note; added: string[]}> {
        this.scope.assertInProject(fromId, 'link_note', opts?.project);
        const note = this.core.notes.get(fromId);
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

        const updated = await this.writeNote(
            {path: note.id, content: body, frontmatter: note.frontmatter},
            opts,
            'link_note'
        );

        return {note: updated, added};
    }
}
