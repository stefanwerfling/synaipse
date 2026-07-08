import type {Note, NoteId, NoteWriteInput} from './Types.js';

export interface NoteWriteContext {
    message?: string;
    author?: {name: string; email: string};
}

/**
 * Per-note index entry tracked by the adapter: content hash for
 * change-detection (decides whether to re-embed) plus a runtime
 * access journal used by recency-biased ranking. Filesystem-backed
 * adapters persist this in a sidecar JSON; DB-backed adapters store
 * it as a column on the notes table plus a small access table.
 */
export interface NoteEntry {
    hash: string;
    mtime: number;
    accessCount?: number;
    lastAccessed?: number;
}

/**
 * Storage port for notes. Two implementations:
 * - FilesystemNoteAdapter (@synaipse/vault) — markdown files + ngit + sidecar HashCache
 * - MariaDBNoteAdapter (@synaipse/server-storage, planned) — DB-backed Hot-Tier
 *
 * See Memory/synaipse/decisions/2026-06-23-server-mode-architecture.md.
 */
export interface NoteAdapter {
    load(): Promise<void>;
    isLoaded(): boolean;
    list(): Note[];
    get(id: NoteId): Note;
    tryGet(id: NoteId): Note | undefined;
    read(id: NoteId): Promise<Note>;
    write(input: NoteWriteInput, ctx?: NoteWriteContext): Promise<Note>;
    delete(id: NoteId, ctx?: NoteWriteContext): Promise<void>;
    backlinksOf(id: NoteId): NoteId[];
    tags(): Map<string, NoteId[]>;

    /** Index-entry queries (hash + access journal). */
    getEntry(id: NoteId): NoteEntry | undefined;
    entryIds(): NoteId[];
    /** Record hash+mtime after successful embedding (used by the indexing batch). Sync; pair with flushEntries() for durability. */
    recordEntry(id: NoteId, hash: string, mtime: number): void;
    /** Bump accessCount/lastAccessed; optionally seed the entry if it does not yet exist. */
    recordAccess(id: NoteId, hashSeed?: string, mtimeSeed?: number): void;
    /** Drop an entry (used when a note is removed externally). */
    removeEntry(id: NoteId): void;
    /** Force a durable write of pending entry changes. */
    flushEntries(): Promise<void>;
    /** Re-read entries from disk if a parallel process touched them. Returns true if anything changed. */
    syncEntries(): Promise<boolean>;
}

/**
 * Token-auth user record. Mirrors `config.server.tokens[]` from yaml mode
 * but lives in a database in server mode. Plain tokens are never stored —
 * verification runs against {tokenHash, tokenSalt} (scrypt).
 */
export interface UserRecord {
    id: number;
    label: string;
    read: boolean;
    write: boolean;
    pathPrefixes: readonly string[];
    tools: readonly string[];
    tokenHint: string;
    createdAt: number;
    lastUsedAt: number | null;
    revokedAt: number | null;
    /** Epoch ms; null means "never expires". findByToken filters out rows where expiresAt is in the past. */
    expiresAt: number | null;
    /** Owner account id (slice 16c); null for legacy / service tokens with no human owner. */
    accountId: number | null;
}

export interface CreateUserInput {
    label: string;
    read: boolean;
    write: boolean;
    pathPrefixes?: readonly string[];
    tools?: readonly string[];
    /** Epoch ms when the token should stop working. Omit for indefinite lifetime. */
    expiresAt?: number | null;
    /**
     * Optional owner account. Slice 16c self-service tokens set this
     * to the logged-in user's id so /api/tokens can scope CRUD per
     * account. CLI-created tokens leave it null = "service token, no
     * human owner".
     */
    accountId?: number | null;
}

export interface CreateUserResult {
    user: UserRecord;
    plainToken: string;
}

export interface RotateUserResult {
    user: UserRecord;
    plainToken: string;
}

/**
 * Storage port for token-auth users. Implementations:
 * - InMemoryUserStore (test helper, packages/mcp-server/test)
 * - MariaDBUserStore (@synaipse/server-storage) — backed by the `users` table
 *
 * Only MariaDBUserStore wires into HTTP middleware (mode=server). Local
 * mode keeps using `config.server.tokens` yaml — see
 * packages/mcp-server/src/Auth.ts:resolveTokenScope.
 */
export interface UserStore {
    createUser(input: CreateUserInput): Promise<CreateUserResult>;
    findByToken(plainToken: string): Promise<UserRecord | null>;
    listUsers(): Promise<UserRecord[]>;
    revokeByLabel(label: string): Promise<boolean>;
    /**
     * Rotate the bearer for an existing label in-place: new hash/salt/hint,
     * `revoked_at` and `last_used_at` cleared, optional new `expires_at`.
     * Preserves id + createdAt + scope (read/write/pathPrefixes/tools).
     * Returns null if no row with the given label exists in this vault.
     */
    rotateByLabel(label: string, expiresAt?: number | null): Promise<RotateUserResult | null>;
    touchLastUsed(id: number): Promise<void>;
    close(): Promise<void>;

    /**
     * Account-scoped self-service operations (slice 16c). The Web-UI
     * /api/tokens routes use these so a logged-in user only sees +
     * mutates their OWN rows. All operations are no-ops / return
     * null when the row exists but belongs to a different account
     * (or has account_id IS NULL — service tokens are admin-only).
     */
    listByAccount(accountId: number): Promise<UserRecord[]>;
    revokeByIdForAccount(id: number, accountId: number): Promise<boolean>;
    rotateByIdForAccount(id: number, accountId: number, expiresAt?: number | null): Promise<RotateUserResult | null>;
}

/**
 * Web-UI login account. Distinct from `UserRecord` above: an account is
 * a human who logs into the Web-UI with email + password, whereas
 * UserRecord is an MCP bearer token. Migration 006 links them via the
 * (currently unused) `users.account_id` column — Slice 16c will populate
 * it when tokens are created via the Self-Service-UI.
 *
 * Server-mode only. Local-mode has no concept of accounts.
 */
export interface AccountRecord {
    id: number;
    email: string;
    isAdmin: boolean;
    createdAt: number;
    lastLoginAt: number | null;
    disabledAt: number | null;
}

export interface CreateAccountInput {
    email: string;
    password: string;
    isAdmin?: boolean;
}

/**
 * Storage port for Web-UI login accounts. Implementations:
 * - InMemoryAccountStore (test helper, packages/mcp-server/test)
 * - MariaDBAccountStore (@synaipse/server-storage) — backed by `accounts`
 *
 * Only wired in mode=server; the Bootstrap-CLI (`npm run admin bootstrap`)
 * creates the first admin row directly because the chicken-and-egg
 * prevents going through the UI for the very first account.
 */
export interface AccountStore {
    create(input: CreateAccountInput): Promise<AccountRecord>;
    findByEmail(email: string): Promise<AccountRecord | null>;
    findById(id: number): Promise<AccountRecord | null>;
    /**
     * Returns the account if email matches AND password verifies AND the
     * account is not disabled. Returns null in every other case — the
     * boundary doesn't distinguish wrong-email from wrong-password from
     * disabled, by design (no enumeration oracle on the login endpoint).
     */
    verifyLogin(email: string, password: string): Promise<AccountRecord | null>;
    listAccounts(): Promise<AccountRecord[]>;
    setDisabled(id: number, disabled: boolean): Promise<boolean>;
    setAdmin(id: number, isAdmin: boolean): Promise<boolean>;
    /**
     * Update the stored password for an account. Used by both the
     * self-service "change my password" flow (Slice 16c) and by admin
     * "reset user password" (Slice 16d). Returns false if no account
     * with the given id exists in this vault.
     */
    setPassword(id: number, password: string): Promise<boolean>;
    touchLastLogin(id: number): Promise<void>;
    close(): Promise<void>;
}

/**
 * Scheduled recurring job (Slice 3 of Jobs-Aufarbeitung). Persisted so
 * a server restart doesn't lose the user's cron config. `jobType` +
 * `jobParams` are stored as opaque strings so this interface stays
 * decoupled from the web/server JobType union; the runner
 * (packages/web/server/scheduler.ts) casts them at fire-time.
 *
 * The cron expression uses a deliberately tiny grammar for v1:
 *   - "every Nh"        — fire every N hours, first N hours after createdAt
 *   - "daily HH:MM"     — fire once per day at HH:MM local time
 *
 * See ScheduleStore below for the storage port.
 */
export interface Schedule {
    id: string;
    name: string;
    jobType: string;
    /** JSON-serialized job params; the runner deserializes + casts to JobParams. */
    jobParams: string;
    cron: string;
    enabled: boolean;
    createdAt: number;
    lastRun?: number;
    lastResult?: 'ok' | 'error' | 'stopped';
    nextRun?: number;
}

export interface ScheduleInput {
    name: string;
    jobType: string;
    jobParams: string;
    cron: string;
    enabled?: boolean;
}

/**
 * Storage port for scheduled jobs. Implementations:
 * - LocalScheduleStore (packages/web/server/local-schedule-store.ts)
 *   — JSON sidecar under `${vaultPath}/.synaipse-schedules.json`
 * - MariaDBScheduleStore (@synaipse/server-storage, planned Slice 3b)
 *   — backed by a `schedules` table analogous to `users`
 */
export interface ScheduleStore {
    list(): Promise<Schedule[]>;
    get(id: string): Promise<Schedule | null>;
    create(input: ScheduleInput): Promise<Schedule>;
    /** Patch a subset of fields. Returns null if no row with that id. */
    update(id: string, patch: Partial<Omit<Schedule, 'id' | 'createdAt'>>): Promise<Schedule | null>;
    delete(id: string): Promise<boolean>;
    close(): Promise<void>;
}