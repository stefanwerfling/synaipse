import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseCron, nextFireTime} from '../server/cron.js';
import {LocalScheduleStore} from '../server/local-schedule-store.js';
import {Scheduler} from '../server/scheduler.js';
import type {JobManager} from '../server/jobs.js';

// ── cron parser ──────────────────────────────────────────────────────

describe('parseCron', () => {
    it('accepts "every Nh" for N in [1, 999]', () => {
        const one = parseCron('every 1h');
        expect(one.ok).toBe(true);
        expect(one).toMatchObject({ok: true, parsed: {kind: 'every-hours', hours: 1}});

        const big = parseCron('every 999h');
        expect(big.ok).toBe(true);
        expect(big).toMatchObject({ok: true, parsed: {kind: 'every-hours', hours: 999}});
    });

    it('rejects "every 0h"', () => {
        const zero = parseCron('every 0h');
        expect(zero.ok).toBe(false);
    });

    it('rejects minute grammar', () => {
        expect(parseCron('every 5m').ok).toBe(false);
        expect(parseCron('every 30min').ok).toBe(false);
    });

    it('accepts "daily HH:MM" at boundaries', () => {
        const early = parseCron('daily 00:00');
        expect(early).toMatchObject({ok: true, parsed: {kind: 'daily', hour: 0, minute: 0}});

        const late = parseCron('daily 23:59');
        expect(late).toMatchObject({ok: true, parsed: {kind: 'daily', hour: 23, minute: 59}});
    });

    it('rejects out-of-range daily times', () => {
        expect(parseCron('daily 24:00').ok).toBe(false);
        expect(parseCron('daily 12:60').ok).toBe(false);
    });

    it('trims and case-normalizes', () => {
        expect(parseCron('  EVERY 2H  ').ok).toBe(true);
        expect(parseCron('DAILY 08:30').ok).toBe(true);
    });

    it('rejects garbage', () => {
        expect(parseCron('').ok).toBe(false);
        expect(parseCron('* * * * *').ok).toBe(false);
        expect(parseCron('sometimes').ok).toBe(false);
    });
});

describe('nextFireTime', () => {
    it('every-hours adds N*3600s to now', () => {
        const now = 1_700_000_000_000;
        const next = nextFireTime({kind: 'every-hours', hours: 2}, now);
        expect(next).toBe(now + 2 * 60 * 60 * 1000);
    });

    it('daily picks today when HH:MM is still ahead', () => {
        // Local 09:00:00 on some day
        const morning = new Date(2026, 5, 15, 9, 0, 0, 0).getTime();
        const next = nextFireTime({kind: 'daily', hour: 10, minute: 30}, morning);
        expect(new Date(next).getHours()).toBe(10);
        expect(new Date(next).getMinutes()).toBe(30);
        // Same day
        expect(new Date(next).getDate()).toBe(15);
    });

    it('daily picks tomorrow when HH:MM has already passed', () => {
        const evening = new Date(2026, 5, 15, 22, 0, 0, 0).getTime();
        const next = nextFireTime({kind: 'daily', hour: 8, minute: 0}, evening);
        expect(new Date(next).getDate()).toBe(16);
        expect(new Date(next).getHours()).toBe(8);
    });
});

// ── LocalScheduleStore ────────────────────────────────────────────────

describe('LocalScheduleStore', () => {
    let dir: string;
    let filePath: string;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'synaipse-schedules-'));
        filePath = path.join(dir, '.synaipse-schedules.json');
    });

    afterEach(async () => {
        await rm(dir, {recursive: true, force: true});
    });

    it('starts empty and creates+lists schedules', async () => {
        const store = new LocalScheduleStore(filePath);
        expect(await store.list()).toHaveLength(0);

        const created = await store.create({
            name: 'Nightly Gitea',
            jobType: 'crawl-gitea',
            jobParams: JSON.stringify({baseUrl: 'https://g', owner: 'o', repo: 'r', project: 'p'}),
            cron: 'daily 03:00'
        });

        expect(created.id).toMatch(/[0-9a-f-]{36}/);
        expect(created.enabled).toBe(true);
        expect(created.createdAt).toBeGreaterThan(0);

        const list = await store.list();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({name: 'Nightly Gitea'});
    });

    it('persists across store instances', async () => {
        const a = new LocalScheduleStore(filePath);
        const created = await a.create({
            name: 'x', jobType: 'relink', jobParams: '{}', cron: 'every 2h'
        });
        await a.close();

        const b = new LocalScheduleStore(filePath);
        const list = await b.list();
        expect(list).toHaveLength(1);
        expect(list[0]?.id).toBe(created.id);
    });

    it('update patches a subset without touching id/createdAt', async () => {
        const store = new LocalScheduleStore(filePath);
        const s = await store.create({
            name: 'x', jobType: 'relink', jobParams: '{}', cron: 'every 2h'
        });
        const originalCreatedAt = s.createdAt;

        const updated = await store.update(s.id, {enabled: false, nextRun: 42});
        expect(updated?.enabled).toBe(false);
        expect(updated?.nextRun).toBe(42);
        expect(updated?.id).toBe(s.id);
        expect(updated?.createdAt).toBe(originalCreatedAt);
    });

    it('update returns null for unknown id', async () => {
        const store = new LocalScheduleStore(filePath);
        expect(await store.update('nope', {enabled: false})).toBeNull();
    });

    it('delete returns true then false', async () => {
        const store = new LocalScheduleStore(filePath);
        const s = await store.create({
            name: 'x', jobType: 'relink', jobParams: '{}', cron: 'every 2h'
        });
        expect(await store.delete(s.id)).toBe(true);
        expect(await store.delete(s.id)).toBe(false);
        expect(await store.list()).toHaveLength(0);
    });

    it('starts empty when file exists but has no schedules key', async () => {
        // Pre-seed a JSON file without the schedules array — should not crash.
        const {writeFile} = await import('node:fs/promises');
        await writeFile(filePath, '{}', 'utf8');
        const store = new LocalScheduleStore(filePath);
        expect(await store.list()).toHaveLength(0);
    });
});

// ── Scheduler runner ──────────────────────────────────────────────────

describe('Scheduler', () => {
    let dir: string;
    let filePath: string;
    let store: LocalScheduleStore;
    let firedJobs: Array<{type: string; params: unknown}>;
    let jobs: JobManager;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'synaipse-scheduler-'));
        filePath = path.join(dir, '.synaipse-schedules.json');
        store = new LocalScheduleStore(filePath);
        firedJobs = [];
        jobs = {
            startJob: (type: string, params: unknown) => {
                firedJobs.push({type, params});
                return {id: 'stub'};
            }
        } as unknown as JobManager;
    });

    afterEach(async () => {
        await store.close();
        await rm(dir, {recursive: true, force: true});
    });

    it('fires a schedule whose nextRun has passed', async () => {
        const s = await store.create({
            name: 'due', jobType: 'relink', jobParams: '{"prefix":"x"}', cron: 'every 2h'
        });
        await store.update(s.id, {nextRun: Date.now() - 1000});

        const scheduler = new Scheduler(store, jobs, {log: () => undefined});
        await scheduler.tickOnce();

        expect(firedJobs).toHaveLength(1);
        expect(firedJobs[0]).toMatchObject({type: 'relink', params: {prefix: 'x'}});

        const after = await store.get(s.id);
        expect(after?.lastResult).toBe('ok');
        expect(after?.lastRun).toBeGreaterThan(0);
        expect(after?.nextRun).toBeGreaterThan(Date.now());
    });

    it('does not fire a schedule whose nextRun is in the future', async () => {
        const s = await store.create({
            name: 'future', jobType: 'relink', jobParams: '{}', cron: 'every 2h'
        });
        await store.update(s.id, {nextRun: Date.now() + 60_000});

        const scheduler = new Scheduler(store, jobs, {log: () => undefined});
        await scheduler.tickOnce();

        expect(firedJobs).toHaveLength(0);
    });

    it('does not fire a disabled schedule even if due', async () => {
        const s = await store.create({
            name: 'off', jobType: 'relink', jobParams: '{}', cron: 'every 2h'
        });
        await store.update(s.id, {nextRun: Date.now() - 1000, enabled: false});

        const scheduler = new Scheduler(store, jobs, {log: () => undefined});
        await scheduler.tickOnce();

        expect(firedJobs).toHaveLength(0);
    });

    it('advances nextRun even when startJob throws', async () => {
        const failingJobs = {
            startJob: () => { throw new Error('boom'); }
        } as unknown as JobManager;

        const s = await store.create({
            name: 'flaky', jobType: 'relink', jobParams: '{}', cron: 'every 2h'
        });
        await store.update(s.id, {nextRun: Date.now() - 1000});

        const scheduler = new Scheduler(store, failingJobs, {log: () => undefined});
        await scheduler.tickOnce();

        const after = await store.get(s.id);
        expect(after?.lastResult).toBe('error');
        expect(after?.nextRun).toBeGreaterThan(Date.now());
    });

    it('backfills nextRun on first tick when missing but does not fire', async () => {
        const s = await store.create({
            name: 'legacy', jobType: 'relink', jobParams: '{}', cron: 'every 2h'
        });
        // Simulate a stored record from a prior version without nextRun.
        await store.update(s.id, {nextRun: undefined});
        // Sanity: nextRun was cleared
        const before = await store.get(s.id);
        expect(before?.nextRun).toBeUndefined();

        const scheduler = new Scheduler(store, jobs, {log: () => undefined});
        await scheduler.tickOnce();

        expect(firedJobs).toHaveLength(0);
        const after = await store.get(s.id);
        expect(after?.nextRun).toBeGreaterThan(Date.now());
    });

    it('disables a schedule whose cron becomes invalid after firing', async () => {
        // Create with valid cron, then poison it before the tick.
        const s = await store.create({
            name: 'poison', jobType: 'relink', jobParams: '{}', cron: 'every 2h'
        });
        await store.update(s.id, {nextRun: Date.now() - 1000, cron: 'garbage'});

        const scheduler = new Scheduler(store, jobs, {log: () => undefined});
        await scheduler.tickOnce();

        const after = await store.get(s.id);
        expect(after?.enabled).toBe(false);
        expect(after?.lastResult).toBe('error');
    });
});