import {randomUUID} from 'node:crypto';
import type {Pool} from 'mariadb';
import type {Schedule, ScheduleInput, ScheduleStore} from '@synaipse/core';
import type {ResolvedMariaDBConfig} from './Pool.js';

interface ScheduleRow {
    id: string;
    name: string;
    job_type: string;
    job_params: string | object;
    cron_spec: string;
    enabled: number;
    created_at: number;
    last_run: number | null;
    last_result: string | null;
    next_run: number | null;
}

const KNOWN_RESULTS = new Set<Schedule['lastResult']>(['ok', 'error', 'stopped']);

const stringifyParams = (raw: string | object): string => {
    if (typeof raw === 'string') return raw;
    // JSON columns come back parsed on some driver versions; re-stringify
    // so downstream consumers get the same opaque string the caller passed.
    try {
        return JSON.stringify(raw);
    } catch {
        return '{}';
    }
};

const parseLastResult = (raw: string | null): Schedule['lastResult'] => {
    if (raw === null) return undefined;
    return KNOWN_RESULTS.has(raw as Schedule['lastResult'])
        ? (raw as Schedule['lastResult'])
        : undefined;
};

const rowToSchedule = (row: ScheduleRow): Schedule => {
    const schedule: Schedule = {
        id: row.id,
        name: row.name,
        jobType: row.job_type,
        jobParams: stringifyParams(row.job_params),
        cron: row.cron_spec,
        enabled: row.enabled === 1,
        createdAt: Number(row.created_at)
    };

    if (row.last_run !== null) schedule.lastRun = Number(row.last_run);
    const lastResult = parseLastResult(row.last_result);
    if (lastResult !== undefined) schedule.lastResult = lastResult;
    if (row.next_run !== null) schedule.nextRun = Number(row.next_run);

    return schedule;
};

/**
 * MariaDB-backed ScheduleStore for SYNAIPSE_MODE=server. Mirrors the
 * semantics of LocalScheduleStore (packages/web/server/local-schedule-store.ts)
 * so the Scheduler runner + /api/schedules routes stay identical.
 *
 * `id` is UUIDv4 assigned client-side at create() time — same as the
 * local store — so future admin export/import doesn't have to renumber.
 */
export class MariaDBScheduleStore implements ScheduleStore {
    public constructor(
        private readonly pool: Pool,
        private readonly config: ResolvedMariaDBConfig
    ) {}

    public async list(): Promise<Schedule[]> {
        const conn = await this.pool.getConnection();

        try {
            const rows = await conn.query<ScheduleRow[]>(
                `SELECT * FROM schedules
                  WHERE vault_id = ?
                  ORDER BY created_at ASC`,
                [this.config.vaultId]
            );

            return rows.map(rowToSchedule);
        } finally {
            await conn.release();
        }
    }

    public async get(id: string): Promise<Schedule | null> {
        const conn = await this.pool.getConnection();

        try {
            const rows = await conn.query<ScheduleRow[]>(
                'SELECT * FROM schedules WHERE vault_id = ? AND id = ?',
                [this.config.vaultId, id]
            );

            const row = rows[0];
            return row === undefined ? null : rowToSchedule(row);
        } finally {
            await conn.release();
        }
    }

    public async create(input: ScheduleInput): Promise<Schedule> {
        const schedule: Schedule = {
            id: randomUUID(),
            name: input.name,
            jobType: input.jobType,
            jobParams: input.jobParams,
            cron: input.cron,
            enabled: input.enabled !== false,
            createdAt: Date.now()
        };

        const conn = await this.pool.getConnection();

        try {
            await conn.query(
                `INSERT INTO schedules
                    (id, vault_id, name, job_type, job_params, cron_spec, enabled, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    schedule.id,
                    this.config.vaultId,
                    schedule.name,
                    schedule.jobType,
                    schedule.jobParams,
                    schedule.cron,
                    schedule.enabled ? 1 : 0,
                    schedule.createdAt
                ]
            );
        } finally {
            await conn.release();
        }

        return schedule;
    }

    public async update(
        id: string,
        patch: Partial<Omit<Schedule, 'id' | 'createdAt'>>
    ): Promise<Schedule | null> {
        // Read-modify-write against a single row keeps the LocalScheduleStore
        // semantics ("update returns null for unknown id" + "preserves id +
        // createdAt"). The read+write happen on the same connection so a
        // concurrent delete between them is the only interleaving that can
        // return a stale schedule — acceptable since update+delete races
        // are already resolved elsewhere by "last writer wins".
        const conn = await this.pool.getConnection();

        try {
            const rows = await conn.query<ScheduleRow[]>(
                'SELECT * FROM schedules WHERE vault_id = ? AND id = ?',
                [this.config.vaultId, id]
            );

            const row = rows[0];
            if (row === undefined) return null;

            const current = rowToSchedule(row);
            const merged: Schedule = {
                ...current,
                ...patch,
                id: current.id,
                createdAt: current.createdAt
            };

            await conn.query(
                `UPDATE schedules
                    SET name = ?,
                        job_type = ?,
                        job_params = ?,
                        cron_spec = ?,
                        enabled = ?,
                        last_run = ?,
                        last_result = ?,
                        next_run = ?
                  WHERE vault_id = ? AND id = ?`,
                [
                    merged.name,
                    merged.jobType,
                    merged.jobParams,
                    merged.cron,
                    merged.enabled ? 1 : 0,
                    merged.lastRun ?? null,
                    merged.lastResult ?? null,
                    merged.nextRun ?? null,
                    this.config.vaultId,
                    id
                ]
            );

            return merged;
        } finally {
            await conn.release();
        }
    }

    public async delete(id: string): Promise<boolean> {
        const conn = await this.pool.getConnection();

        try {
            const result = await conn.query(
                'DELETE FROM schedules WHERE vault_id = ? AND id = ?',
                [this.config.vaultId, id]
            );

            return result.affectedRows > 0;
        } finally {
            await conn.release();
        }
    }

    public async close(): Promise<void> {
        // Pool lifecycle is owned by the bundle, not the individual store.
    }
}