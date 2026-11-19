import type {NoteAdapter, NoteId} from '@synaipse/core';
import type {History} from '@synaipse/vault';
import {Diff, type VerifyReport} from 'ngit';
import {buildActivityReport, toActivityCommit, type ActivityCommit, type ActivityReport} from '../Activity.js';
import type {NoteHistoryEntry, RemovedNote, SnapshotEntry} from './Types.js';
import {isoDate, isPathNotFound} from './Util.js';

/**
 * Read side of the vault's version history (ngit): per-note history,
 * versions and diffs, the activity feed, removed notes and snapshots.
 * Without a repository every read is empty.
 */
export class HistoryService {
    public constructor(
        private readonly history: History,
        private readonly notes: NoteAdapter
    ) {}

    /** True whenever the History UI should be available. The repo may not exist yet (no Synaipse write so far); reads are then empty. */
    public async historyEnabled(): Promise<boolean> {
        if (this.history.isConfigured()) {
            return true;
        }

        return (await this.history.getRepo()) !== null;
    }

    public async verifyHistory(): Promise<VerifyReport | null> {
        const repo = await this.history.getRepo();

        if (repo === null) {
            return null;
        }

        return repo.verify();
    }

    public async snapshotList(commitSha: string, treePath?: string): Promise<SnapshotEntry[]> {
        const repo = await this.history.getRepo();

        if (repo === null) {
            return [];
        }

        const snap = repo.at(commitSha);
        const entries = await snap.list(treePath);
        return entries.map((e) => ({name: e.name, type: e.type, sha: e.sha}));
    }

    public async snapshotWalk(commitSha: string, pathPrefix = ''): Promise<{path: string; sha: string}[]> {
        const repo = await this.history.getRepo();

        if (repo === null) {
            return [];
        }

        const snap = repo.at(commitSha);
        const result: {path: string; sha: string}[] = [];

        for await (const entry of snap.walk()) {
            if (pathPrefix.length === 0 || entry.path.startsWith(pathPrefix)) {
                result.push(entry);
            }
        }

        return result;
    }

    public async noteHistory(id: NoteId, limit = 50): Promise<NoteHistoryEntry[]> {
        const repo = await this.history.getRepo();

        if (repo === null) {
            return [];
        }

        let entries;

        try {
            entries = await repo.log({path: id, limit});
        } catch (cause) {
            if (isPathNotFound(cause)) {
                return [];
            }
            throw cause;
        }

        return entries.map((e) => ({
            sha: e.sha,
            message: e.message.trim(),
            author: {
                name: e.author.name,
                email: e.author.email,
                date: isoDate(e.author.timestamp)
            },
            parents: e.parents
        }));
    }

    public async getActivity(opts: {sinceDays?: number; limit?: number} = {}): Promise<ActivityReport> {
        const repo = await this.history.getRepo();

        if (repo === null) {
            return {total: 0, commits: [], timeline: [], hotNotes: [], byTool: [], byProject: []};
        }

        // Overfetch — log has no time filter, so we just pull the most recent
        // N commits and filter by date in buildActivityReport.
        const fetchLimit = opts.limit ?? 1000;
        const entries = await repo.log({limit: fetchLimit});

        return buildActivityReport(
            entries.map((e) => ({
                sha: e.sha,
                author: {name: e.author.name, date: isoDate(e.author.timestamp)},
                message: e.message
            })),
            {
                ...(opts.sinceDays !== undefined ? {sinceDays: opts.sinceDays} : {}),
                commitsCap: 100,
                hotNotesTop: 10
            }
        );
    }

    /**
     * Vault commits newest-first, one page at a time (plan P4 / A5).
     * Keyset pagination: `before` is the sha of the last commit of the
     * previous page and the walk continues at its first parent, so pages
     * stay stable while new commits land on top. Unknown sha → throws.
     */
    public async activityCommits(opts: {limit: number; before?: string}): Promise<{commits: ActivityCommit[]; next: string | null}> {
        const repo = await this.history.getRepo();

        if (repo === null) {
            return {commits: [], next: null};
        }

        let cursor: string | null = opts.before === undefined
            ? await repo.head()
            : (await repo.readCommit(opts.before)).parents[0] ?? null;
        const commits: ActivityCommit[] = [];

        while (cursor !== null && commits.length < opts.limit) {
            const commit = await repo.readCommit(cursor);
            commits.push(toActivityCommit({
                sha: cursor,
                author: {name: commit.author.name, date: isoDate(commit.author.timestamp)},
                message: commit.message
            }));
            cursor = commit.parents[0] ?? null;
        }

        const last = commits[commits.length - 1];
        return {commits, next: cursor !== null && last !== undefined ? last.sha : null};
    }

    public async noteVersion(id: NoteId, commitSha: string): Promise<string> {
        const repo = await this.history.getRepo();

        if (repo === null) {
            throw new Error('history disabled — no .ngit found in vault');
        }

        const buf = await repo.show(commitSha, id);
        return buf.toString('utf8');
    }

    public async noteDiff(id: NoteId, fromSha: string, toSha?: string): Promise<string> {
        const repo = await this.history.getRepo();

        if (repo === null) {
            return '';
        }

        const resolvedTo = toSha ?? (await repo.head());

        if (resolvedTo === null) {
            return '';
        }

        try {
            const [before, after] = await Promise.all([
                repo.show(fromSha, id).then((b) => b.toString('utf8')),
                repo.show(resolvedTo, id).then((b) => b.toString('utf8'))
            ]);

            return Diff.unified(before, after, {
                fromLabel: `${id} @ ${fromSha.slice(0, 7)}`,
                toLabel: `${id} @ ${resolvedTo.slice(0, 7)}`
            });
        } catch (cause) {
            if (isPathNotFound(cause)) {
                return '';
            }
            throw cause;
        }
    }

    /**
     * Notes removed since `sinceMs` (deleted, or archived by decay) that are
     * still gone, newest first, from the version history; empty without it.
     */
    public async removedSince(sinceMs: number, limit = 200): Promise<RemovedNote[]> {
        const repo = await this.history.getRepo();
        if (repo === null) return [];

        const entries = await repo.log({limit: 5000});
        const out = new Map<NoteId, RemovedNote>();

        for (const e of entries) {
            const at = e.author.timestamp * 1000;
            if (at < sinceMs) break;

            const commit = toActivityCommit({sha: e.sha, author: {name: e.author.name, date: new Date(at)}, message: e.message});
            const how = commit.tool === 'delete_note' ? 'deleted' : commit.tool === 'archive_stale' ? 'archived' : null;
            const id = commit.noteId;

            if (how === null || id === null || out.has(id) || this.notes.tryGet(id) !== undefined) continue;
            // archive_stale also commits the archive copy; only the vanished original counts.
            out.set(id, {id, at, how});
            if (out.size >= limit) break;
        }

        return [...out.values()];
    }
}
