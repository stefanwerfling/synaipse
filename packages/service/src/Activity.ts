/**
 * Vault-activity aggregation from the ngit commit log.
 *
 * Service writes commits with messages of the form
 *     `synaipse(<project>?): <tool> <noteId>`
 * via buildCommitMessage. We parse that back out so the UI can show
 * "what happened in the vault over the last N days" without diffing
 * every commit.
 */

export interface ActivityCommit {
    sha: string;
    /** Unix ms. */
    ts: number;
    author: string;
    /** synaipse|synaipse(project) — derived from commit author scope. */
    project: string | null;
    /** write_note, relink, compile, import_chatgpt, clip, delete_note, log_session, ... */
    tool: string;
    /** Note id touched by this commit, parsed from the commit subject. */
    noteId: string | null;
    /** First non-trailer line, in case the user wants to read it. */
    subject: string;
}

export interface ActivityBucket {
    /** YYYY-MM-DD. */
    date: string;
    commits: number;
    /** Distinct notes touched in this bucket. */
    notes: number;
}

export interface ActivityCount {
    key: string;
    count: number;
}

export interface ActivityReport {
    /** Total commits considered (after windowing). */
    total: number;
    /** Most recent commits (capped). */
    commits: ActivityCommit[];
    /** Per-day bucket, ascending. */
    timeline: ActivityBucket[];
    /** Top N most-edited notes in window. */
    hotNotes: Array<{noteId: string; edits: number}>;
    /** Tool histogram. */
    byTool: ActivityCount[];
    /** Project histogram. */
    byProject: ActivityCount[];
}

export interface RawLogEntry {
    sha: string;
    author: {name: string; date: string | Date};
    message: string;
}

const SUBJECT_RE = /^synaipse(?:\(([^)]+)\))?:\s+(\S+)\s+(.+?)\s*$/;

const parseSubject = (message: string): {project: string | null; tool: string; noteId: string; subject: string} => {
    const firstLine = message.split('\n')[0]?.trim() ?? '';
    const match = SUBJECT_RE.exec(firstLine);

    if (match === null) {
        return {project: null, tool: 'unknown', noteId: '', subject: firstLine};
    }

    return {
        project: match[1] ?? null,
        tool: match[2] ?? 'unknown',
        noteId: match[3] ?? '',
        subject: firstLine
    };
};

const tsOf = (date: string | Date): number => {
    if (date instanceof Date) return date.getTime();
    const parsed = Date.parse(date);
    return Number.isFinite(parsed) ? parsed : 0;
};

const dayKey = (ms: number): string => {
    const d = new Date(ms);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
};

export const buildActivityReport = (
    entries: readonly RawLogEntry[],
    opts: {sinceDays?: number; commitsCap?: number; hotNotesTop?: number} = {}
): ActivityReport => {
    const now = Date.now();
    const window = opts.sinceDays !== undefined && opts.sinceDays > 0
        ? now - opts.sinceDays * 86_400_000
        : 0;

    const commits: ActivityCommit[] = [];

    for (const e of entries) {
        const ts = tsOf(e.author.date);
        if (ts < window) continue;

        const parsed = parseSubject(e.message);
        commits.push({
            sha: e.sha,
            ts,
            author: e.author.name,
            project: parsed.project,
            tool: parsed.tool,
            noteId: parsed.noteId.length > 0 ? parsed.noteId : null,
            subject: parsed.subject
        });
    }

    commits.sort((a, b) => b.ts - a.ts);

    // Per-day buckets (ascending so the chart reads left→right).
    const byDay = new Map<string, {commits: number; notes: Set<string>}>();

    for (const c of commits) {
        const key = dayKey(c.ts);
        let bucket = byDay.get(key);

        if (bucket === undefined) {
            bucket = {commits: 0, notes: new Set()};
            byDay.set(key, bucket);
        }

        bucket.commits += 1;
        if (c.noteId !== null) bucket.notes.add(c.noteId);
    }

    // Fill missing days inside the window so the timeline doesn't skip
    // empty buckets — much nicer to look at as a chart.
    if (opts.sinceDays !== undefined && opts.sinceDays > 0) {
        const start = new Date(window);
        const end = new Date(now);

        for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
            const key = dayKey(d.getTime());
            if (!byDay.has(key)) byDay.set(key, {commits: 0, notes: new Set()});
        }
    }

    const timeline: ActivityBucket[] = [...byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, bucket]) => ({date, commits: bucket.commits, notes: bucket.notes.size}));

    // Hot notes — distinct edits per noteId.
    const editsByNote = new Map<string, number>();
    for (const c of commits) {
        if (c.noteId === null) continue;
        editsByNote.set(c.noteId, (editsByNote.get(c.noteId) ?? 0) + 1);
    }

    const hotNotes = [...editsByNote.entries()]
        .map(([noteId, edits]) => ({noteId, edits}))
        .sort((a, b) => b.edits - a.edits)
        .slice(0, opts.hotNotesTop ?? 10);

    // Histograms.
    const histogram = (key: (c: ActivityCommit) => string | null): ActivityCount[] => {
        const counts = new Map<string, number>();

        for (const c of commits) {
            const k = key(c);
            if (k === null) continue;
            counts.set(k, (counts.get(k) ?? 0) + 1);
        }

        return [...counts.entries()]
            .map(([key, count]) => ({key, count}))
            .sort((a, b) => b.count - a.count);
    };

    return {
        total: commits.length,
        commits: commits.slice(0, opts.commitsCap ?? 100),
        timeline,
        hotNotes,
        byTool: histogram((c) => c.tool),
        byProject: histogram((c) => c.project ?? '<no project>')
    };
};