import {describe, it, expect, beforeAll, afterAll, beforeEach} from 'vitest';
import type {Pool} from 'mariadb';
import {MariaDBUserStore} from '../src/MariaDBUserStore.js';
import type {ResolvedMariaDBConfig} from '../src/Pool.js';
import {connectAndMigrate, integrationEnabled} from './helpers.js';

/**
 * Guards backlog #17: TIMESTAMP columns (server-side CURRENT_TIMESTAMP)
 * and JS-Date-sent columns must land in the same TZ frame. Regression
 * would manifest as a systematic multi-hour skew between `created_at`
 * and `expires_at` on the same row, which used to happen on hosts
 * running MariaDB in a non-UTC SYSTEM TZ. Fix is `timezone: 'auto'` on
 * the pool in Pool.ts — see the comment there for why not 'Z'/'UTC'.
 */
describe.skipIf(!integrationEnabled)('MariaDB session TZ (integration)', () => {
    let pool: Pool;
    let cfg: ResolvedMariaDBConfig;

    beforeAll(async () => {
        ({pool, cfg} = await connectAndMigrate());
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query('TRUNCATE TABLE users');
    });

    it('session TZ is not "SYSTEM" (driver has aligned it to Node local)', async () => {
        // With `timezone: 'auto'` the driver queries the server SYSTEM TZ
        // on connect and, if it doesn't match Node's local, issues a
        // `SET time_zone = ?` to fix the mismatch. Either way the session
        // ends up on a fixed offset (never the literal 'SYSTEM' value).
        const conn = await pool.getConnection();
        try {
            const rows = await conn.query<Array<{tz: string}>>(
                "SELECT @@session.time_zone AS tz"
            );
            const tz = rows[0]?.tz ?? '';
            // Accept either a fixed offset (e.g. '+02:00', '-05:00', '+00:00')
            // or an IANA name (rare, only if MariaDB's tz tables are loaded).
            // The one thing we refuse to accept is 'SYSTEM' — that means
            // the driver didn't intervene, which is the pre-fix behaviour.
            expect(tz).not.toBe('SYSTEM');
            expect(tz.length).toBeGreaterThan(0);
        } finally {
            await conn.release();
        }
    });

    it('created_at and expires_at land in the same frame (no TZ skew)', async () => {
        const store = new MariaDBUserStore(pool, cfg);
        const now = Date.now();
        const oneHourAhead = now + 60 * 60 * 1000;

        const {user} = await store.createUser({
            label: 'tz-probe',
            read: true,
            write: false,
            expiresAt: oneHourAhead
        });

        // createdAt should be within a couple of seconds of `now` — write
        // latency + clock drift. A TZ misconfiguration would push this hours
        // off.
        expect(Math.abs(user.createdAt - now)).toBeLessThan(5_000);

        // expiresAt is the value we sent; it should round-trip exactly (or
        // within a second — TIMESTAMP has 1s resolution by default).
        expect(user.expiresAt).not.toBeNull();
        expect(Math.abs((user.expiresAt as number) - oneHourAhead)).toBeLessThan(1_500);

        // And crucially: the delta between the two columns should match
        // the delta we specified (1h), not 1h ± host-TZ-offset hours.
        const delta = (user.expiresAt as number) - user.createdAt;
        expect(Math.abs(delta - 60 * 60 * 1000)).toBeLessThan(5_000);
    });
});