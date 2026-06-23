import {describe, it, expect, beforeAll, afterAll, beforeEach} from 'vitest';
import type {Pool} from 'mariadb';
import type {ChatSession} from '@synaipse/core';
import {MariaDBChatAdapter} from '../src/MariaDBChatAdapter.js';
import type {ResolvedMariaDBConfig} from '../src/Pool.js';
import {connectAndMigrate, integrationEnabled} from './helpers.js';

const buildSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
    id: '2026-06-24-hello.md',
    title: 'Hello chat',
    createdAt: '2026-06-24T10:00:00.000Z',
    updatedAt: '2026-06-24T10:05:00.000Z',
    lastModel: 'sonnet',
    turns: [
        {role: 'user', content: 'hi'},
        {
            role: 'assistant',
            content: 'hey',
            model: 'sonnet',
            sources: [{target: 'Notes/Greeting.md', title: 'Greeting', index: 1}]
        }
    ],
    ...overrides
});

describe.skipIf(!integrationEnabled)('MariaDBChatAdapter (integration)', () => {
    let pool: Pool;
    let cfg: ResolvedMariaDBConfig;

    beforeAll(async () => {
        ({pool, cfg} = await connectAndMigrate());
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query('TRUNCATE TABLE chat_sessions');
    });

    it('load() empty + uniqueId returns the basename unchanged', async () => {
        const adapter = new MariaDBChatAdapter(pool, cfg);
        await adapter.load();
        expect(adapter.isLoaded()).toBe(true);
        expect(await adapter.list()).toEqual([]);
        expect(adapter.uniqueId('fresh.md')).toBe('fresh.md');
    });

    it('write + list builds summaries from surface columns', async () => {
        const adapter = new MariaDBChatAdapter(pool, cfg);
        await adapter.load();

        await adapter.write(buildSession());

        const summaries = await adapter.list();
        expect(summaries).toHaveLength(1);
        expect(summaries[0]?.title).toBe('Hello chat');
        expect(summaries[0]?.turnCount).toBe(2);
        expect(summaries[0]?.lastModel).toBe('sonnet');
    });

    it('get() round-trips turns + sources through the JSON payload', async () => {
        const adapter = new MariaDBChatAdapter(pool, cfg);
        await adapter.load();
        await adapter.write(buildSession());

        const got = await adapter.get('2026-06-24-hello.md');
        expect(got.turns).toHaveLength(2);
        expect(got.turns[1]?.sources?.[0]).toEqual({
            target: 'Notes/Greeting.md',
            title: 'Greeting',
            index: 1
        });
    });

    it('uniqueId collides after write, frees up after delete', async () => {
        const adapter = new MariaDBChatAdapter(pool, cfg);
        await adapter.load();
        await adapter.write(buildSession());

        expect(adapter.uniqueId('2026-06-24-hello.md')).toBe('2026-06-24-hello-2.md');

        await adapter.delete('2026-06-24-hello.md');
        expect(adapter.uniqueId('2026-06-24-hello.md')).toBe('2026-06-24-hello.md');
    });

    it('id set survives reload from DB', async () => {
        const a = new MariaDBChatAdapter(pool, cfg);
        await a.load();
        await a.write(buildSession());

        const fresh = new MariaDBChatAdapter(pool, cfg);
        await fresh.load();
        expect(await fresh.exists('2026-06-24-hello.md')).toBe(true);
        expect(fresh.uniqueId('2026-06-24-hello.md')).toBe('2026-06-24-hello-2.md');
    });
});