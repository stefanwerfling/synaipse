import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {SynaipseService} from '@synaipse/service';
import type {EventBroadcaster} from '../server/events.js';
import {relayJobEvents, type JobUpdate} from '../server/job-events.js';
import {JobManager, type JobFeedEvent, type JobRecord} from '../server/jobs.js';

/** Job progress on the one event stream per tab. */

const gatedService = () => {
    const gates: Array<() => void> = [];
    const service = {
        listNotes: () => [{id: 'a.md'}, {id: 'b.md'}],
        batch: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
        relinkNote: () => new Promise((resolve) => {
            gates.push(() => resolve({skipped: false, accepted: ['x']}));
        })
    };
    return {service: service as unknown as SynaipseService, gates};
};

const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('JobManager.onAnyEvent', () => {
    it('sees the start, queueing, progress and end of every job', async () => {
        const fake = gatedService();
        const jobs = new JobManager(fake.service, {});
        const seen: Array<[string, JobFeedEvent['kind'], string]> = [];
        const off = jobs.onAnyEvent((job, event) => seen.push([job.id, event.kind, job.status]));

        const first = jobs.startJob('relink', {prefix: ''}, {scheduleId: 's1'});
        const second = jobs.startJob('relink', {prefix: ''});
        expect(seen[0]).toEqual([first.id, 'started', 'running']);
        expect(seen.filter((x) => x[0] === second.id)).toEqual([[second.id, 'queued', 'queued']]);

        for (let i = 0; i < 40 && second.status !== 'done'; i++) {
            await new Promise((r) => setTimeout(r, 0));
            fake.gates.splice(0).forEach((g) => g());
        }
        expect(second.status).toBe('done');

        const kinds = (id: string): string[] => seen.filter((s) => s[0] === id).map((s) => s[1]);
        expect(kinds(first.id).at(-1)).toBe('done');
        expect(kinds(first.id)).toContain('progress');
        expect(kinds(second.id).slice(0, 2)).toEqual(['queued', 'started']);
        expect(kinds(second.id).at(-1)).toBe('done');

        off();
        const count = seen.length;
        jobs.startJob('compile', {prefix: 'none/'});
        expect(seen.length).toBe(count);
        jobs.stopAll();
    });
});

describe('relayJobEvents', () => {
    let listener: ((job: JobRecord, event: JobFeedEvent) => void) | null;
    let sent: JobUpdate[];
    let off: () => void;
    const job: JobRecord = {
        id: 'j1', type: 'relink', params: {prefix: ''}, status: 'running', scheduleId: 's1',
        progress: {done: 0, total: 10, failed: 0}, startedAt: 0, logs: ['secret log line']
    };
    const fire = (event: JobFeedEvent): void => listener?.(job, event);
    const progress = (done: number): void => {
        job.progress.done = done;
        fire({kind: 'progress', done, total: 10, failed: 0});
    };

    beforeEach(() => {
        vi.useFakeTimers();
        listener = null;
        sent = [];
        job.status = 'running';
        job.progress = {done: 0, total: 10, failed: 0};
        const jobs = {
            onAnyEvent: (fn: typeof listener) => {
                listener = fn;
                return () => {
                    listener = null;
                };
            }
        } as unknown as JobManager;
        const broadcaster = {
            publishNamed: (name: string, data: unknown) => {
                expect(name).toBe('job');
                sent.push(data as JobUpdate);
            }
        } as unknown as EventBroadcaster;
        off = relayJobEvents(jobs, broadcaster, {intervalMs: 250});
    });

    afterEach(() => {
        off();
        vi.useRealTimers();
    });

    it('sends the state without params and log, and drops log lines', () => {
        fire({kind: 'started'});
        fire({kind: 'log', message: 'x'});
        expect(sent).toEqual([{
            id: 'j1', type: 'relink', status: 'running', scheduleId: 's1',
            progress: {done: 0, total: 10, failed: 0}
        }]);
    });

    it('throttles progress per job and sends the latest state', () => {
        progress(1);
        progress(2);
        progress(3);
        expect(sent.map((u) => u.progress.done)).toEqual([1]);
        vi.advanceTimersByTime(249);
        expect(sent).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(sent.map((u) => u.progress.done)).toEqual([1, 3]);
        // A sent update is a copy, not the live object.
        progress(4);
        expect(sent[1]!.progress.done).toBe(3);
    });

    it('sends the end at once and drops held-back progress', () => {
        progress(1);
        progress(2);
        job.status = 'done';
        job.summary = '2 relinked';
        fire({kind: 'done', summary: '2 relinked'});
        vi.advanceTimersByTime(1000);
        expect(sent.map((u) => u.status)).toEqual(['running', 'done']);
        expect(sent[1]!.summary).toBe('2 relinked');
    });

    it('stops relaying after the unsubscribe', async () => {
        progress(1);
        progress(2);
        off();
        vi.advanceTimersByTime(1000);
        await flush();
        expect(listener).toBeNull();
        expect(sent).toHaveLength(1);
    });
});
