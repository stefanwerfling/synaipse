import {randomUUID} from 'node:crypto';
import {readFile, rename, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import type {Schedule, ScheduleInput, ScheduleStore} from '@synaipse/core';

/**
 * File-backed ScheduleStore for local-mode. Persists to a single JSON
 * sidecar (default `${vaultPath}/.synaipse-schedules.json`) using
 * temp-file + rename for atomicity — a partial write while the process
 * is being killed would otherwise corrupt every stored schedule at
 * once, since we always rewrite the whole file.
 *
 * The store is in-process, single-instance (one web-server owns the
 * file). Concurrent mutations from within the same process are
 * serialized through `writeQueue` so a burst of API calls can't race
 * the JSON dump against itself.
 *
 * Server-mode (mode=server) will use MariaDBScheduleStore from
 * @synaipse/server-storage — planned for Slice 3b. Both share the
 * ScheduleStore interface so the runner + routes stay identical.
 */
export class LocalScheduleStore implements ScheduleStore {
    private readonly filePath: string;
    private data: Map<string, Schedule> = new Map();
    private loaded = false;
    private writeQueue: Promise<void> = Promise.resolve();

    public constructor(filePath: string) {
        this.filePath = filePath;
    }

    private async ensureLoaded(): Promise<void> {
        if (this.loaded) return;
        this.loaded = true;

        try {
            const raw = await readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(raw) as {schedules?: Schedule[]};
            const list = Array.isArray(parsed.schedules) ? parsed.schedules : [];
            for (const s of list) {
                this.data.set(s.id, s);
            }
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
                // First run — file doesn't exist yet. Nothing to load.
                return;
            }
            throw cause;
        }
    }

    private async persist(): Promise<void> {
        // Chain onto the previous write so bursts serialize instead of
        // racing. Each caller awaits their own chained promise, so
        // errors propagate to the right invoker.
        const write = async (): Promise<void> => {
            await mkdir(path.dirname(this.filePath), {recursive: true});
            const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
            const payload = JSON.stringify(
                {schedules: [...this.data.values()]},
                null,
                2
            );
            await writeFile(tmp, payload, 'utf8');
            await rename(tmp, this.filePath);
        };

        const next = this.writeQueue.then(write, write);
        // Swallow this-chain errors from the tail so a failed write
        // doesn't poison subsequent invocations.
        this.writeQueue = next.catch(() => undefined);
        return next;
    }

    public async list(): Promise<Schedule[]> {
        await this.ensureLoaded();
        return [...this.data.values()].sort((a, b) => a.createdAt - b.createdAt);
    }

    public async get(id: string): Promise<Schedule | null> {
        await this.ensureLoaded();
        return this.data.get(id) ?? null;
    }

    public async create(input: ScheduleInput): Promise<Schedule> {
        await this.ensureLoaded();

        const schedule: Schedule = {
            id: randomUUID(),
            name: input.name,
            jobType: input.jobType,
            jobParams: input.jobParams,
            cron: input.cron,
            enabled: input.enabled !== false,
            createdAt: Date.now()
        };

        this.data.set(schedule.id, schedule);
        await this.persist();
        return schedule;
    }

    public async update(
        id: string,
        patch: Partial<Omit<Schedule, 'id' | 'createdAt'>>
    ): Promise<Schedule | null> {
        await this.ensureLoaded();

        const current = this.data.get(id);
        if (current === undefined) return null;

        const updated: Schedule = {
            ...current,
            ...patch,
            // id + createdAt are locked; patch cannot override them via the type,
            // but be defensive anyway.
            id: current.id,
            createdAt: current.createdAt
        };

        this.data.set(id, updated);
        await this.persist();
        return updated;
    }

    public async delete(id: string): Promise<boolean> {
        await this.ensureLoaded();
        const existed = this.data.delete(id);
        if (existed) await this.persist();
        return existed;
    }

    public async close(): Promise<void> {
        // Wait for any in-flight write to drain so shutdown doesn't
        // truncate the sidecar mid-rename.
        await this.writeQueue;
    }
}