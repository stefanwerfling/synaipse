import {createHash} from 'node:crypto';
import type {
    CreateUserInput,
    CreateUserResult,
    RotateUserResult,
    UserRecord,
    UserStore
} from '@synaipse/core';

interface CacheEntry {
    record: UserRecord;
    expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000;

const hashKey = (plain: string): string => createHash('sha256').update(plain).digest('hex');

/**
 * Decorator around any UserStore that caches successful findByToken hits
 * so the underlying scrypt verify (≈50ms) doesn't run on every MCP
 * request. Cache key is sha256(plainToken) — the plaintext bearer never
 * sits in the Map, which keeps a process memory dump from leaking
 * credentials.
 *
 * Cache misses (unknown tokens) are NOT cached: the hint-index pre-filter
 * in MariaDBUserStore already short-circuits random tokens to ≈1ms, and
 * caching misses would force a separate TTL story for negative results.
 *
 * Invalidation: revokeByLabel flushes the entire cache. That's coarser
 * than necessary but cheap and immediate — a revoked token can never
 * re-authenticate, even within the TTL window of its previous successful
 * verification.
 *
 * createUser and listUsers pass through; touchLastUsed also passes
 * through (the cached record carries the lastUsedAt from cache time,
 * which is fine for ACL — the DB column is observability, not auth).
 */
export class CachedUserStore implements UserStore {
    private readonly cache = new Map<string, CacheEntry>();

    public constructor(
        private readonly inner: UserStore,
        private readonly ttlMs: number = DEFAULT_TTL_MS,
        private readonly now: () => number = Date.now
    ) {}

    public async createUser(input: CreateUserInput): Promise<CreateUserResult> {
        return this.inner.createUser(input);
    }

    public async findByToken(plainToken: string): Promise<UserRecord | null> {
        const key = hashKey(plainToken);
        const cached = this.cache.get(key);

        if (cached !== undefined && cached.expiresAt > this.now()) {
            return cached.record;
        }

        if (cached !== undefined) {
            this.cache.delete(key);
        }

        const record = await this.inner.findByToken(plainToken);

        if (record !== null) {
            // Cache expiry is bounded by min(now+ttlMs, record.expiresAt).
            // Without the cap, a user expiring in 10s could be cached for
            // the full TTL (default 60s) — that's a 50s window of accepting
            // an already-expired bearer.
            const ttlExpiry = this.now() + this.ttlMs;
            const userExpiry = record.expiresAt ?? Number.POSITIVE_INFINITY;
            this.cache.set(key, {record, expiresAt: Math.min(ttlExpiry, userExpiry)});
        }

        return record;
    }

    public async listUsers(): Promise<UserRecord[]> {
        return this.inner.listUsers();
    }

    public async revokeByLabel(label: string): Promise<boolean> {
        const ok = await this.inner.revokeByLabel(label);
        if (ok) {
            this.cache.clear();
        }
        return ok;
    }

    public async rotateByLabel(label: string, expiresAt?: number | null): Promise<RotateUserResult | null> {
        const result = await this.inner.rotateByLabel(label, expiresAt);
        // After rotation, the old token (potentially still in the cache) is
        // dead. Same semantics as revoke — flush the whole cache so a
        // stale entry can't silently keep authenticating the prior secret.
        if (result !== null) {
            this.cache.clear();
        }
        return result;
    }

    public async touchLastUsed(id: number): Promise<void> {
        return this.inner.touchLastUsed(id);
    }

    public async listByAccount(accountId: number): Promise<UserRecord[]> {
        return this.inner.listByAccount(accountId);
    }

    public async revokeByIdForAccount(id: number, accountId: number): Promise<boolean> {
        const ok = await this.inner.revokeByIdForAccount(id, accountId);
        // Same coarse-but-cheap flush as revokeByLabel — once any token
        // is revoked we cannot let a stale cached entry keep authenticating.
        if (ok) {
            this.cache.clear();
        }
        return ok;
    }

    public async rotateByIdForAccount(
        id: number,
        accountId: number,
        expiresAt?: number | null
    ): Promise<RotateUserResult | null> {
        const result = await this.inner.rotateByIdForAccount(id, accountId, expiresAt);
        if (result !== null) {
            this.cache.clear();
        }
        return result;
    }

    public async close(): Promise<void> {
        this.cache.clear();
        return this.inner.close();
    }

    /**
     * Number of cached entries — exposed for diagnostics / tests, not
     * used by the auth path itself.
     */
    public size(): number {
        return this.cache.size;
    }

    /** Force-flush the cache. Useful for admin tooling. */
    public flush(): void {
        this.cache.clear();
    }
}