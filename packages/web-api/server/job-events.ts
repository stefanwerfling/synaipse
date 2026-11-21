import type {EventBroadcaster} from './events.js';
import type {JobFeedEvent, JobManager, JobRecord, JobStatus} from './jobs.js';

/** What a browser tab gets per job change: the job's state, without its log. */
export interface JobUpdate {
    id: string;
    type: JobRecord['type'];
    status: JobStatus;
    progress: JobRecord['progress'];
    scheduleId?: string;
    summary?: string;
    error?: string;
}

const TERMINAL = new Set<JobFeedEvent['kind']>(['done', 'failed', 'stopped']);

const toUpdate = (job: JobRecord): JobUpdate => ({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: {...job.progress},
    ...(job.scheduleId !== undefined ? {scheduleId: job.scheduleId} : {}),
    ...(job.summary !== undefined ? {summary: job.summary} : {}),
    ...(job.error !== undefined ? {error: job.error} : {})
});

export interface JobRelayOptions {
    /** Progress of one job goes out at most this often. Default 250 ms. */
    intervalMs?: number;
}

/**
 * Job changes as `job` events on the one event stream per browser tab
 * (an own stream per watched job added up against the 6-connection limit
 * of HTTP/1.1). Every tab gets them, not only the one watching, so
 * progress is throttled per job: a crawl reports per item, a tab needs a
 * few updates a second. Start and end go out at once, the end after any
 * held-back progress is dropped. Log lines stay on `/api/jobs/:id/stream`.
 *
 * Returns the unsubscribe; it also drops pending updates.
 */
export const relayJobEvents = (
    jobs: JobManager,
    broadcaster: EventBroadcaster,
    opts: JobRelayOptions = {}
): (() => void) => {
    const intervalMs = opts.intervalMs ?? 250;
    const lastSent = new Map<string, number>();
    const pending = new Map<string, ReturnType<typeof setTimeout>>();

    const send = (job: JobRecord): void => {
        lastSent.set(job.id, Date.now());
        broadcaster.publishNamed('job', toUpdate(job));
    };

    const off = jobs.onAnyEvent((job, event) => {
        if (event.kind === 'log') return;

        if (TERMINAL.has(event.kind)) {
            clearTimeout(pending.get(job.id));
            pending.delete(job.id);
            lastSent.delete(job.id);
            broadcaster.publishNamed('job', toUpdate(job));
            return;
        }

        if (event.kind !== 'progress') {
            send(job);
            return;
        }

        if (pending.has(job.id)) return;

        const wait = (lastSent.get(job.id) ?? 0) + intervalMs - Date.now();
        if (wait <= 0) {
            send(job);
            return;
        }

        const timer = setTimeout(() => {
            pending.delete(job.id);
            send(job);
        }, wait);
        timer.unref?.();
        pending.set(job.id, timer);
    });

    return () => {
        off();
        for (const timer of pending.values()) clearTimeout(timer);
        pending.clear();
        lastSent.clear();
    };
};
