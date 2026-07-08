import type {Schedule, ScheduleStore} from '@synaipse/core';
import type {JobManager, JobParams, JobType} from './jobs.js';
import {nextFireForCron} from './cron.js';

const DEFAULT_TICK_INTERVAL_MS = 30_000;

export interface SchedulerOptions {
    /** Override the tick interval; tests use 50ms so the loop actually runs. */
    tickIntervalMs?: number;
    /** Optional stdout tag; defaults to '[scheduler]'. */
    logTag?: string;
    /** Function that receives log lines. Defaults to process.stdout.write. */
    log?: (line: string) => void;
}

/**
 * Fires stored schedules by handing them off to the JobManager. Ticks
 * every ~30s (interval configurable for tests) and picks up every
 * enabled schedule whose `nextRun` is in the past. Result of the fire
 * attempt lands back in the store as `lastRun` + `lastResult`.
 *
 * The runner is deliberately single-instance and single-process — in
 * server-mode with multiple web-server replicas you'd need a leader-
 * election layer to avoid double-firing, but that's out of scope for
 * Slice 3.
 *
 * We DON'T fire "missed" schedules from before startup — if the server
 * was offline when a `daily 08:00` was due, we log it and move to the
 * next occurrence. This matches user intuition: crontab doesn't
 * replay missed runs either.
 */
export class Scheduler {
    private readonly store: ScheduleStore;
    private readonly jobs: JobManager;
    private readonly tickIntervalMs: number;
    private readonly logTag: string;
    private readonly log: (line: string) => void;
    private timer: NodeJS.Timeout | null = null;
    private ticking = false;

    public constructor(store: ScheduleStore, jobs: JobManager, opts: SchedulerOptions = {}) {
        this.store = store;
        this.jobs = jobs;
        this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
        this.logTag = opts.logTag ?? '[scheduler]';
        this.log = opts.log ?? ((line) => process.stdout.write(line));
    }

    public start(): void {
        if (this.timer !== null) return;
        this.log(`${this.logTag} started (tick=${this.tickIntervalMs}ms)\n`);
        this.timer = setInterval(() => {
            void this.tickOnce();
        }, this.tickIntervalMs);
        // Fire an immediate tick so a schedule that was already due at
        // startup gets picked up right away instead of waiting a full
        // tick interval.
        void this.tickOnce();
    }

    public stop(): void {
        if (this.timer === null) return;
        clearInterval(this.timer);
        this.timer = null;
        this.log(`${this.logTag} stopped\n`);
    }

    /**
     * Run one iteration of the tick loop. Exposed for tests + for
     * `POST /api/schedules/:id/run-now` (which reads the record,
     * updates nextRun to now, then triggers a tick).
     */
    public async tickOnce(): Promise<void> {
        if (this.ticking) return;  // re-entrance guard for slow ticks
        this.ticking = true;

        try {
            const now = Date.now();
            const schedules = await this.store.list();
            for (const s of schedules) {
                if (!s.enabled) continue;

                // First-load safety: if nextRun is missing entirely
                // (e.g. schedule created by an older version of the
                // code), compute one and skip firing this tick.
                if (s.nextRun === undefined) {
                    try {
                        await this.store.update(s.id, {nextRun: nextFireForCron(s.cron, now)});
                    } catch (cause) {
                        this.log(`${this.logTag} ! ${s.id} has invalid cron '${s.cron}': ${String(cause)}\n`);
                    }
                    continue;
                }

                if (s.nextRun > now) continue;

                await this.fire(s, now);
            }
        } catch (cause) {
            this.log(`${this.logTag} ! tick failed: ${String(cause)}\n`);
        } finally {
            this.ticking = false;
        }
    }

    private async fire(s: Schedule, now: number): Promise<void> {
        let result: 'ok' | 'error' = 'ok';

        try {
            const params = JSON.parse(s.jobParams) as JobParams;
            this.jobs.startJob(s.jobType as JobType, params);
            this.log(`${this.logTag} → fired '${s.name}' (${s.jobType})\n`);
        } catch (cause) {
            result = 'error';
            this.log(`${this.logTag} ! failed to fire '${s.name}': ${String(cause)}\n`);
        }

        // Always advance nextRun, even on error — otherwise a broken
        // schedule would fire every tick forever. Cron parse errors
        // land the schedule in a disabled state via the try below.
        let nextRun: number | undefined;
        try {
            nextRun = nextFireForCron(s.cron, now);
        } catch (cause) {
            this.log(`${this.logTag} ! disabling '${s.name}': ${String(cause)}\n`);
            await this.store.update(s.id, {
                lastRun: now,
                lastResult: 'error',
                enabled: false
            });
            return;
        }

        await this.store.update(s.id, {
            lastRun: now,
            lastResult: result,
            nextRun
        });
    }
}