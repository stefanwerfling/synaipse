import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import mariadb, {type Pool} from 'mariadb';

export interface MariaDBConfig {
    host: string;
    port?: number;
    user: string;
    password: string;
    database: string;
    connectionLimit?: number;
    /**
     * Vault namespace inside a shared DB. Local-mode boots default to 1.
     * Multi-vault deployments assign distinct ids per vault root.
     */
    vaultId?: number;
}

export interface ResolvedMariaDBConfig extends MariaDBConfig {
    connectionLimit: number;
    vaultId: number;
}

// `dist/Pool.js` lives one level below the package root; migrations
// sit beside `src/` (not inside it) so tsc leaves them alone.
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const MIGRATION_FILES = [
    '001_notes.sql',
    '002_chats.sql',
    '003_users.sql',
    '004_user_expiry.sql',
    '005_accounts.sql',
    '006_tokens_account_fk.sql',
    '007_schedules.sql'
] as const;

export const createPool = (cfg: MariaDBConfig): Pool => {
    return mariadb.createPool({
        host: cfg.host,
        port: cfg.port ?? 3306,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        connectionLimit: cfg.connectionLimit ?? 10,
        // The driver returns BIGINT as JS bigint by default; the adapter only
        // surfaces string NoteIds, so the bigint never escapes the boundary —
        // but plain numbers are easier to pass through `mtime_ms` queries.
        bigIntAsNumber: true,
        // Multiple statements off by default — migrations split into per-file
        // calls so each one fits in one statement.
        multipleStatements: false,
        // Align server-session TZ with Node's local TZ so `CURRENT_TIMESTAMP`
        // (server-side) and JS-Date-encoded columns (client-side) land in
        // the same frame. Without this, hosts running MariaDB in a
        // different SYSTEM TZ than the Node process show a systematic
        // multi-hour skew between `created_at` and `expires_at` on the
        // same row (backlog #17).
        //
        // Why 'auto' and not 'Z' / 'UTC': the driver's JS-Date encoder
        // (packet-output-stream.js#writeBinaryDate) uses LOCAL-TZ getters
        // (`getHours` etc.) unconditionally — forcing session TZ to UTC
        // while the encoder emits CEST wall-clock creates the OPPOSITE
        // skew. 'auto' queries the server's SYSTEM tz on connect, converts
        // it to a fixed offset that matches Node's local TZ, then SET
        // time_zone on the session. Encoder and server both interpret
        // "13:04:00" as the same instant.
        //
        // For deployments that want DB timestamps in UTC, set the Node
        // process's TZ to UTC (Docker containers already default to UTC;
        // for bare-metal, `TZ=UTC node …`). 'auto' then keeps everything
        // in UTC.
        timezone: 'auto'
    });
};

export const resolveConfig = (cfg: MariaDBConfig): ResolvedMariaDBConfig => ({
    ...cfg,
    connectionLimit: cfg.connectionLimit ?? 10,
    vaultId: cfg.vaultId ?? 1
});

/**
 * Applies the bundled SQL migrations against the given pool. Each file
 * is idempotent (`CREATE TABLE IF NOT EXISTS` etc.) so re-running the
 * migrator is safe. A real migration ledger lands with Phase 4 (the
 * Local→Server CLI); until then this covers the boot path of a fresh
 * server-mode container.
 */
export const applyMigrations = async (pool: Pool): Promise<void> => {
    const conn = await pool.getConnection();
    try {
        for (const file of MIGRATION_FILES) {
            const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
            await conn.query(sql);
        }
    } finally {
        await conn.release();
    }
};