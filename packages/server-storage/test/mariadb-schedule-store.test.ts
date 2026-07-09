import {describe, it, expect, beforeAll, afterAll, beforeEach} from 'vitest';
import type {Pool} from 'mariadb';
import {MariaDBScheduleStore} from '../src/MariaDBScheduleStore.js';
import type {ResolvedMariaDBConfig} from '../src/Pool.js';
import {connectAndMigrate, integrationEnabled} from './helpers.js';

describe.skipIf(!integrationEnabled)('MariaDBScheduleStore (integration)', () => {
    let pool: Pool;
    let cfg: ResolvedMariaDBConfig;

    beforeAll(async () => {
        ({pool, cfg} = await connectAndMigrate());
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query('TRUNCATE TABLE schedules');
    });

    it('starts empty and creates+lists schedules with defaults', async () => {
        const store = new MariaDBScheduleStore(pool, cfg);
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
        expect(created.lastRun).toBeUndefined();
        expect(created.lastResult).toBeUndefined();
        expect(created.nextRun).toBeUndefined();

        const list = await store.list();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
            name: 'Nightly Gitea',
            jobType: 'crawl-gitea',
            cron: 'daily 03:00'
        });
        expect(JSON.parse(list[0]!.jobParams)).toMatchObject({owner: 'o'});
    });

    it('respects enabled=false on create', async () => {
        const store = new MariaDBScheduleStore(pool, cfg);
        const created = await store.create({
            name: 'off', jobType: 'relink', jobParams: '{}', cron: 'every 2h',
            enabled: false
        });
        expect(created.enabled).toBe(false);
        const round = await store.get(created.id);
        expect(round?.enabled).toBe(false);
    });

    it('list() orders by createdAt ascending', async () => {
        const store = new MariaDBScheduleStore(pool, cfg);
        const first = await store.create({name: 'a', jobType: 'relink', jobParams: '{}', cron: 'every 2h'});
        // Bump the second row's created_at by a millisecond to guarantee ordering
        // even on very fast machines where Date.now() might collide.
        await new Promise((resolve) => setTimeout(resolve, 2));
        const second = await store.create({name: 'b', jobType: 'relink', jobParams: '{}', cron: 'every 3h'});

        const list = await store.list();
        expect(list.map((s) => s.id)).toEqual([first.id, second.id]);
    });

    it('get() returns null for unknown id', async () => {
        const store = new MariaDBScheduleStore(pool, cfg);
        expect(await store.get('does-not-exist')).toBeNull();
    });

    it('update patches a subset without touching id/createdAt', async () => {
        const store = new MariaDBScheduleStore(pool, cfg);
        const s = await store.create({
            name: 'x', jobType: 'relink', jobParams: '{}', cron: 'every 2h'
        });
        const originalCreatedAt = s.createdAt;

        const updated = await store.update(s.id, {enabled: false, nextRun: 42});
        expect(updated?.enabled).toBe(false);
        expect(updated?.nextRun).toBe(42);
        expect(updated?.id).toBe(s.id);
        expect(updated?.createdAt).toBe(originalCreatedAt);

        // Round-trip: re-read from DB
        const reread = await store.get(s.id);
        expect(reread?.enabled).toBe(false);
        expect(reread?.nextRun).toBe(42);
        expect(reread?.createdAt).toBe(originalCreatedAt);
    });

    it('update round-trips runtime state (lastRun, lastResult, nextRun)', async () => {
        const store = new MariaDBScheduleStore(pool, cfg);
        const s = await store.create({
            name: 'x', jobType: 'relink', jobParams: '{}', cron: 'every 2h'
        });

        await store.update(s.id, {lastRun: 111, lastResult: 'ok', nextRun: 222});
        const reread = await store.get(s.id);
        expect(reread?.lastRun).toBe(111);
        expect(reread?.lastResult).toBe('ok');
        expect(reread?.nextRun).toBe(222);

        // And clear them again
        await store.update(s.id, {lastRun: undefined, lastResult: undefined, nextRun: undefined});
        const cleared = await store.get(s.id);
        expect(cleared?.lastRun).toBeUndefined();
        expect(cleared?.lastResult).toBeUndefined();
        expect(cleared?.nextRun).toBeUndefined();
    });

    it('update returns null for unknown id', async () => {
        const store = new MariaDBScheduleStore(pool, cfg);
        expect(await store.update('nope', {enabled: false})).toBeNull();
    });

    it('delete returns true then false', async () => {
        const store = new MariaDBScheduleStore(pool, cfg);
        const s = await store.create({
            name: 'x', jobType: 'relink', jobParams: '{}', cron: 'every 2h'
        });
        expect(await store.delete(s.id)).toBe(true);
        expect(await store.delete(s.id)).toBe(false);
        expect(await store.list()).toHaveLength(0);
    });

    it('scopes to vault_id (rows in vault 2 are invisible to vault 1)', async () => {
        const v1Store = new MariaDBScheduleStore(pool, cfg);
        const v2Store = new MariaDBScheduleStore(pool, {...cfg, vaultId: cfg.vaultId + 1});

        const v1s = await v1Store.create({
            name: 'v1', jobType: 'relink', jobParams: '{}', cron: 'every 2h'
        });
        await v2Store.create({
            name: 'v2', jobType: 'relink', jobParams: '{}', cron: 'every 2h'
        });

        expect((await v1Store.list()).map((s) => s.name)).toEqual(['v1']);
        expect((await v2Store.list()).map((s) => s.name)).toEqual(['v2']);

        // Cross-vault get returns null even if id matches
        expect(await v2Store.get(v1s.id)).toBeNull();
    });
});