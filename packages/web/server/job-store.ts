import type {StatementSync} from 'node:sqlite';
import {StateDb} from '@synaipse/vault';
import type {JobRecord} from './jobs.js';

/**
 * Where the JobManager keeps its records (plan P4 / A5). The in-memory
 * variant is the old behaviour; the SQLite one survives restarts.
 */
export interface JobStore {
    /** Most recent jobs, newest first. */
    loadRecent(limit: number): JobRecord[];
    save(job: JobRecord): void;
    /** Keep only the newest `keep` finished jobs. */
    prune(keep: number): void;
    close(): void;
}

export class MemoryJobStore implements JobStore {
    public loadRecent(): JobRecord[] {
        return [];
    }

    public save(): void {}

    public prune(): void {}

    public close(): void {}
}

/** Param keys that hold credentials; never written to disk. */
const SECRET_KEYS = new Set(['token', 'apiKey', 'password', 'secret']);

export const redactParams = (params: object): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
        if (SECRET_KEYS.has(key)) {
            if (value !== undefined && value !== '') out[key] = '***';
            continue;
        }
        out[key] = value;
    }
    return out;
};

/** Jobs in the vault's `state.db` (table from StateDb migration 2). */
export class SqliteJobStore implements JobStore {
    private readonly state: StateDb;
    private readonly upsert: StatementSync;
    private readonly pruneStmt: StatementSync;

    public constructor(file: string) {
        this.state = new StateDb(file);
        this.upsert = this.state.db.prepare(
            `INSERT INTO jobs (id, type, status, started_at, finished_at, record) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at, record = excluded.record`
        );
        this.pruneStmt = this.state.db.prepare(
            `DELETE FROM jobs WHERE status NOT IN ('running', 'queued') AND id NOT IN (
                SELECT id FROM jobs ORDER BY started_at DESC LIMIT ?
            )`
        );
    }

    public loadRecent(limit: number): JobRecord[] {
        const rows = this.state.db
            .prepare('SELECT record FROM jobs ORDER BY started_at DESC LIMIT ?')
            .all(limit) as Array<{record: string}>;
        const out: JobRecord[] = [];

        for (const row of rows) {
            try {
                out.push(JSON.parse(row.record) as JobRecord);
            } catch {
                // a corrupt row is skipped, not fatal
            }
        }

        return out;
    }

    public save(job: JobRecord): void {
        const record: JobRecord = {...job, params: redactParams(job.params) as unknown as JobRecord['params']};
        this.upsert.run(job.id, job.type, job.status, job.startedAt, job.finishedAt ?? null, JSON.stringify(record));
    }

    public prune(keep: number): void {
        this.pruneStmt.run(keep);
    }

    public close(): void {
        this.state.close();
    }
}
