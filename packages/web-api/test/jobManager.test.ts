import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {SynaipseService} from '@synaipse/service';
import {JobManager, type JobRecord} from '../server/jobs.js';
import {SqliteJobStore, redactParams} from '../server/job-store.js';

/** relinkNote calls park here until the test releases them. */
interface Gate {
    id: string;
    release: () => void;
}

const fakeService = () => {
    const gates: Gate[] = [];
    let batches = 0;
    const service = {
        listNotes: () => [{id: 'a.md'}, {id: 'b.md'}],
        batch: async <T>(fn: () => Promise<T>): Promise<T> => {
            batches++;
            return fn();
        },
        relinkNote: (id: string) => new Promise((resolve) => {
            gates.push({id, release: () => resolve({skipped: false, accepted: ['x']})});
        })
    };
    return {
        service: service as unknown as SynaipseService,
        gates,
        batches: () => batches
    };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Release parked relinkNote calls until `job` is no longer running. */
const drain = async (fake: ReturnType<typeof fakeService>, job: JobRecord): Promise<void> => {
    for (let i = 0; i < 20 && job.status === 'running'; i++) {
        await tick();
        fake.gates.splice(0).forEach((g) => g.release());
        await tick();
    }
};

let dir: string;
let file: string;

beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'jobs-test-'));
    file = path.join(dir, 'state.db');
});

afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
});

describe('JobManager', () => {
    it('runs one job per type, queues the next and starts it after the first', async () => {
        const fake = fakeService();
        const jobs = new JobManager(fake.service, {});

        const first = jobs.startJob('relink', {prefix: ''});
        const second = jobs.startJob('relink', {prefix: ''});
        const other = jobs.startJob('compile', {prefix: 'none/'});

        expect(first.status).toBe('running');
        expect(second.status).toBe('queued');
        expect(other.status).not.toBe('queued'); // other type: not blocked

        await drain(fake, first);
        expect(first.status).toBe('done');
        await drain(fake, second);
        expect(second.status).toBe('done');
        // The queued job started only after the first one had finished.
        expect(second.startedAt).toBeGreaterThanOrEqual(first.finishedAt!);
        // Every run is one write batch.
        expect(fake.batches()).toBe(3);
    });

    it('stops a queued job without running it', async () => {
        const fake = fakeService();
        const jobs = new JobManager(fake.service, {});
        const first = jobs.startJob('relink', {prefix: ''});
        const queued = jobs.startJob('relink', {prefix: ''});

        expect(jobs.stopJob(queued.id)).toBe(true);
        expect(queued.status).toBe('stopped');

        await drain(fake, first);
        await tick();
        expect(queued.status).toBe('stopped');
        expect(fake.batches()).toBe(1);
    });

    it('persists history across restarts and closes interrupted jobs as failed', async () => {
        const fake = fakeService();
        const store = new SqliteJobStore(file);
        const jobs = new JobManager(fake.service, {}, store);

        const done = jobs.startJob('relink', {prefix: ''});
        await drain(fake, done);
        const running = jobs.startJob('relink', {prefix: ''});
        const queued = jobs.startJob('relink', {prefix: ''});
        await tick();
        // Simulated crash: no stopAll, store just goes away.
        jobs.close();

        const restarted = new JobManager(fakeService().service, {}, new SqliteJobStore(file));
        const byId = new Map(restarted.listJobs().map((j) => [j.id, j]));

        expect(byId.get(done.id)?.status).toBe('done');
        expect(byId.get(done.id)?.summary).toContain('linked 2');
        expect(byId.get(running.id)?.status).toBe('failed');
        expect(byId.get(running.id)?.error).toMatch(/interrupted/);
        expect(byId.get(queued.id)?.status).toBe('failed');
        expect(byId.get(queued.id)?.error).toMatch(/not started/);
        restarted.close();

        // The failure was written back, so a second restart sees the same.
        const again = new SqliteJobStore(file);
        expect(again.loadRecent(10).find((j) => j.id === running.id)?.status).toBe('failed');
        again.close();
    });

    it('stopAll stops queued jobs too', () => {
        const fake = fakeService();
        const jobs = new JobManager(fake.service, {});
        jobs.startJob('relink', {prefix: ''});
        const queued = jobs.startJob('relink', {prefix: ''});

        jobs.stopAll();
        expect(queued.status).toBe('stopped');
    });
});

describe('SqliteJobStore', () => {
    const record = (i: number, extra: Partial<JobRecord> = {}): JobRecord => ({
        id: `j${i}`, type: 'relink', params: {prefix: ''}, status: 'done',
        progress: {done: 0, total: 0, failed: 0}, startedAt: i, logs: [], ...extra
    });

    it('never writes credentials and prunes old finished jobs', () => {
        const store = new SqliteJobStore(file);
        store.save(record(0, {
            type: 'crawl-gitea',
            params: {baseUrl: 'https://g.example', owner: 'o', repo: 'r', project: 'p', token: 's3cret'}
        }));
        for (let i = 1; i <= 5; i++) store.save(record(i));
        store.save(record(6, {status: 'running'}));

        const gitea = store.loadRecent(100).find((j) => j.id === 'j0');
        expect(JSON.stringify(gitea)).not.toContain('s3cret');
        expect((gitea?.params as {token?: string}).token).toBe('***');

        store.prune(3);
        expect(store.loadRecent(100).map((j) => j.id)).toEqual(['j6', 'j5', 'j4']);
        store.close();
    });

    it('redacts only secret keys', () => {
        expect(redactParams({token: 't', apiKey: '', owner: 'o'})).toEqual({token: '***', owner: 'o'});
    });
});
