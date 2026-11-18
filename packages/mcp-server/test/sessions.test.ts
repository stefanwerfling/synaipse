import {describe, expect, it} from 'vitest';
import {resolveSessionLimits, SessionTable} from '../src/Sessions.js';

describe('SessionTable', () => {
    const table = (ttlMs: number, max: number) => {
        let now = 0;
        const evicted: string[] = [];
        const t = new SessionTable<string>({ttlMs, max}, (id) => evicted.push(id), () => now);
        return {t, evicted, advance: (ms: number) => { now += ms; }};
    };

    it('closes sessions idle longer than the TTL, never busy ones', async () => {
        const {t, evicted, advance} = table(1000, 10);
        t.set('a', 'A');
        t.set('b', 'B');
        advance(600);
        await t.use('b', async () => undefined);
        advance(600);
        expect(t.sweep()).toBe(1);
        expect(evicted).toEqual(['a']);

        let release!: () => void;
        const busy = t.use('b', () => new Promise<void>((r) => { release = r; }));
        advance(5000);
        expect(t.sweep()).toBe(0);
        release();
        await busy;
        advance(1001);
        expect(t.sweep()).toBe(1);
        expect(t.size).toBe(0);
    });

    it('closes the longest idle session beyond the cap', async () => {
        const {t, evicted, advance} = table(60_000, 2);
        t.set('a', 'A');
        advance(1);
        t.set('b', 'B');
        advance(1);
        await t.use('a', async () => undefined);
        advance(1);
        t.set('c', 'C');
        expect(evicted).toEqual(['b']);
        expect(t.get('a')).toBe('A');
        expect(t.get('c')).toBe('C');
    });

    it('reads limits from env with defaults for bad values', () => {
        expect(resolveSessionLimits({})).toEqual({ttlMs: 1_800_000, max: 1000});
        expect(resolveSessionLimits({SYNAIPSE_MCP_SESSION_TTL_MS: '5000', SYNAIPSE_MCP_MAX_SESSIONS: 'x'})).toEqual({ttlMs: 5000, max: 1000});
    });
});
