import {mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import type {DatabaseSync as DatabaseSyncT} from 'node:sqlite';

// Loaded via require: `node:sqlite` exists only with the `node:` prefix,
// and bundlers / vite-node strip that prefix from static imports.
const {DatabaseSync} = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * Local app state of a vault in one SQLite file (plan P1 / A2), by
 * default `<vault>/.synaipse/state.db`. Uses the built-in `node:sqlite`
 * — no native dependency. Replaces JSON sidecars that were rewritten in
 * full on every change.
 *
 * Schema changes are append-only migrations keyed by `PRAGMA user_version`.
 */
const MIGRATIONS: readonly string[] = [
    // 1: per-note index entries (hash, embedding state, access journal)
    `CREATE TABLE entries (
        id               TEXT PRIMARY KEY,
        hash             TEXT NOT NULL,
        mtime            REAL NOT NULL,
        embedded_hash    TEXT NOT NULL DEFAULT '',
        embed_model      TEXT,
        access_count     INTEGER,
        last_accessed    REAL,
        referenced_count INTEGER,
        last_referenced  REAL
    )`,
    // 2: background jobs of the web server (plan P4 / A5). The full record
    // is JSON (secrets stripped); the columns exist for ordering/pruning.
    `CREATE TABLE jobs (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        status      TEXT NOT NULL,
        started_at  REAL NOT NULL,
        finished_at REAL,
        record      TEXT NOT NULL
    );
    CREATE INDEX jobs_started_at ON jobs (started_at)`
];

export class StateDb {
    public readonly db: DatabaseSyncT;

    public constructor(public readonly file: string) {
        if (file !== ':memory:') {
            mkdirSync(path.dirname(file), {recursive: true});
        }
        this.db = new DatabaseSync(file);
        // WAL: readers never block the writer, and a parallel CLI process
        // (npm run relink) can share the file. NORMAL is durable across
        // application crashes; only an OS crash may lose the last commit.
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
        this.db.exec('PRAGMA busy_timeout = 5000');
        this.migrate();
    }

    private migrate(): void {
        const row = this.db.prepare('PRAGMA user_version').get() as {user_version: number};
        for (let v = row.user_version; v < MIGRATIONS.length; v++) {
            this.transaction(() => {
                this.db.exec(MIGRATIONS[v]!);
                this.db.exec(`PRAGMA user_version = ${v + 1}`);
            });
        }
    }

    /** Run `fn` in one transaction (rolled back if it throws). */
    public transaction<T>(fn: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    /**
     * Changes whenever ANOTHER connection commits to the file — the cheap
     * way to notice a parallel process wrote state.
     */
    public dataVersion(): number {
        return (this.db.prepare('PRAGMA data_version').get() as {data_version: number}).data_version;
    }

    public close(): void {
        if (this.db.isOpen) {
            this.db.close();
        }
    }
}
