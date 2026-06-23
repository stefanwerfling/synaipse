import {applyMigrations, createPool, resolveConfig, type ResolvedMariaDBConfig} from '../src/Pool.js';

/**
 * Integration tests in this package talk to a real MariaDB. They are
 * skipped by default so `npm test` works without Docker, and only
 * run when `SYNAIPSE_TEST_MARIADB=1` is set. Spin the bundled
 * container with `npm run docker:up:server` first.
 */
export const integrationEnabled = process.env.SYNAIPSE_TEST_MARIADB === '1';

export const testConfig = (): ResolvedMariaDBConfig => resolveConfig({
    host: process.env.SYNAIPSE_TEST_MARIADB_HOST ?? '127.0.0.1',
    port: Number(process.env.SYNAIPSE_TEST_MARIADB_PORT ?? '3307'),
    user: process.env.SYNAIPSE_TEST_MARIADB_USER ?? 'synaipse',
    password: process.env.SYNAIPSE_TEST_MARIADB_PASSWORD ?? 'synaipse',
    database: process.env.SYNAIPSE_TEST_MARIADB_DATABASE ?? 'synaipse'
});

export const connectAndMigrate = async () => {
    const cfg = testConfig();
    const pool = createPool(cfg);
    await applyMigrations(pool);
    return {pool, cfg};
};