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

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

const MIGRATION_FILES = ['001_notes.sql', '002_chats.sql'] as const;

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
        multipleStatements: false
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