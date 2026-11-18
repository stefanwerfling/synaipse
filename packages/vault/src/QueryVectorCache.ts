import type {StatementSync} from 'node:sqlite';
import {StateDb} from './StateDb.js';

export interface QueryVectorCacheOptions {
    /** Entries kept; the least recently used go first. Default 2000. */
    capacity?: number;
}

/** Prune at most every this many inserts (one DELETE instead of one per insert). */
const PRUNE_EVERY = 50;

/**
 * Query embeddings in the vault's `state.db` (plan P4 / A4), so repeated
 * queries skip the embedder after a restart too. Implements the
 * `PersistentQueryCache` port of `@synaipse/vector`.
 *
 * - Keys are opaque hashes (fingerprint + text, built by the caller): the
 *   query text never lands on disk.
 * - Vectors are stored as Float64, so a cached vector is bit-identical to
 *   a freshly embedded one and scores do not drift.
 * - Errors are swallowed: the cache is an optimisation, a broken or locked
 *   database must not break search.
 */
export class QueryVectorCache {
    private readonly state: StateDb;
    private readonly getStmt: StatementSync;
    private readonly touchStmt: StatementSync;
    private readonly putStmt: StatementSync;
    private readonly pruneStmt: StatementSync;
    private readonly capacity: number;
    private insertsSincePrune = 0;

    public constructor(file: string, opts: QueryVectorCacheOptions = {}) {
        this.capacity = opts.capacity ?? 2000;
        this.state = new StateDb(file);
        const db = this.state.db;
        this.getStmt = db.prepare('SELECT vector FROM query_vectors WHERE key = ?');
        this.touchStmt = db.prepare('UPDATE query_vectors SET used_at = ? WHERE key = ?');
        this.putStmt = db.prepare(
            `INSERT INTO query_vectors (key, vector, used_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET vector = excluded.vector, used_at = excluded.used_at`
        );
        this.pruneStmt = db.prepare(
            `DELETE FROM query_vectors WHERE key NOT IN (
                SELECT key FROM query_vectors ORDER BY used_at DESC LIMIT ?
            )`
        );
    }

    public get(key: string): number[] | undefined {
        try {
            const row = this.getStmt.get(key) as {vector: Uint8Array} | undefined;
            if (row === undefined) return undefined;

            this.touchStmt.run(Date.now(), key);
            const bytes = row.vector;
            const copy = new Uint8Array(bytes.byteLength);
            copy.set(bytes);
            return Array.from(new Float64Array(copy.buffer));
        } catch {
            return undefined;
        }
    }

    public set(key: string, vector: readonly number[]): void {
        try {
            const bytes = new Uint8Array(Float64Array.from(vector).buffer);
            this.putStmt.run(key, bytes, Date.now());

            if (++this.insertsSincePrune >= PRUNE_EVERY) {
                this.insertsSincePrune = 0;
                this.pruneStmt.run(this.capacity);
            }
        } catch {
            // optimisation only
        }
    }

    /** Number of stored entries (tests, diagnostics). */
    public size(): number {
        return (this.state.db.prepare('SELECT COUNT(*) AS n FROM query_vectors').get() as {n: number}).n;
    }

    public prune(): void {
        this.pruneStmt.run(this.capacity);
    }

    public close(): void {
        this.state.close();
    }
}
