import type {Pool} from 'mariadb';
import type {ChatAdapter, ChatSession, ChatSummary} from '@synaipse/core';
import type {ResolvedMariaDBConfig} from './Pool.js';

interface SummaryRow {
    session_id: string;
    title: string;
    last_model: string | null;
    updated_at_iso: string;
    turn_count: number;
}

interface PayloadRow {
    payload: string | object;
}

const parsePayload = (raw: string | object): ChatSession => {
    if (typeof raw === 'string') {
        return JSON.parse(raw) as ChatSession;
    }
    return raw as ChatSession;
};

/**
 * MariaDB-backed ChatAdapter. Sessions are stored as one row per
 * conversation: the full ChatSession lives in `payload` (JSON), with
 * the surface columns (title, last_model, created_at_iso,
 * updated_at_iso, turn_count) duplicated alongside so `list()` can
 * build summaries without parsing every payload.
 *
 * `uniqueId()` is sync per the port; the adapter keeps an in-memory
 * Set of known session ids, warmed at load() and kept fresh on
 * write/delete. Concurrent writers from a second process would
 * desync this set — same caveat as the Filesystem adapter's
 * existsSync.
 */
export class MariaDBChatAdapter implements ChatAdapter {
    private knownIds = new Set<string>();
    private loaded = false;

    public constructor(
        private readonly pool: Pool,
        private readonly cfg: ResolvedMariaDBConfig
    ) {}

    public async load(): Promise<void> {
        const rows = await this.pool.query<{session_id: string}[]>(
            'SELECT session_id FROM chat_sessions WHERE vault_id = ?',
            [this.cfg.vaultId]
        );
        this.knownIds.clear();
        for (const row of rows) {
            this.knownIds.add(row.session_id);
        }
        this.loaded = true;
    }

    public isLoaded(): boolean {
        return this.loaded;
    }

    public async list(): Promise<ChatSummary[]> {
        const rows = await this.pool.query<SummaryRow[]>(
            `SELECT session_id, title, last_model, updated_at_iso, turn_count
             FROM chat_sessions
             WHERE vault_id = ?
             ORDER BY updated_at_iso DESC`,
            [this.cfg.vaultId]
        );
        return rows.map((row) => ({
            id: row.session_id,
            title: row.title,
            updatedAt: row.updated_at_iso,
            ...(row.last_model !== null ? {lastModel: row.last_model} : {}),
            turnCount: row.turn_count
        }));
    }

    public async get(id: string): Promise<ChatSession> {
        const session = await this.tryGet(id);
        if (session === null) {
            throw new Error(`Chat session not found: ${id}`);
        }
        return session;
    }

    public async tryGet(id: string): Promise<ChatSession | null> {
        const rows = await this.pool.query<PayloadRow[]>(
            'SELECT payload FROM chat_sessions WHERE vault_id = ? AND session_id = ?',
            [this.cfg.vaultId, id]
        );
        const row = rows[0];
        if (row === undefined) return null;
        return parsePayload(row.payload);
    }

    public async write(session: ChatSession): Promise<void> {
        const payload = JSON.stringify(session);
        await this.pool.query(
            `INSERT INTO chat_sessions
                 (vault_id, session_id, title, last_model,
                  created_at_iso, updated_at_iso, turn_count, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                 title = VALUES(title),
                 last_model = VALUES(last_model),
                 created_at_iso = VALUES(created_at_iso),
                 updated_at_iso = VALUES(updated_at_iso),
                 turn_count = VALUES(turn_count),
                 payload = VALUES(payload)`,
            [
                this.cfg.vaultId,
                session.id,
                session.title,
                session.lastModel ?? null,
                session.createdAt,
                session.updatedAt,
                session.turns.length,
                payload
            ]
        );
        this.knownIds.add(session.id);
    }

    public async delete(id: string): Promise<void> {
        await this.pool.query(
            'DELETE FROM chat_sessions WHERE vault_id = ? AND session_id = ?',
            [this.cfg.vaultId, id]
        );
        this.knownIds.delete(id);
    }

    public async exists(id: string): Promise<boolean> {
        // In-memory set is the cheap path; falls through to a DB check
        // only if load() hasn't run yet (defensive — Service.start()
        // calls load() unconditionally).
        if (this.loaded) return this.knownIds.has(id);
        const rows = await this.pool.query<{n: number}[]>(
            'SELECT COUNT(*) AS n FROM chat_sessions WHERE vault_id = ? AND session_id = ?',
            [this.cfg.vaultId, id]
        );
        return (rows[0]?.n ?? 0) > 0;
    }

    public uniqueId(basename: string): string {
        if (!this.knownIds.has(basename)) return basename;

        const dot = basename.lastIndexOf('.');
        const stem = dot === -1 ? basename : basename.slice(0, dot);
        const ext = dot === -1 ? '' : basename.slice(dot);

        for (let i = 2; i < 1000; i += 1) {
            const candidate = `${stem}-${i}${ext}`;
            if (!this.knownIds.has(candidate)) return candidate;
        }

        throw new Error(`could not allocate unique chat id near ${basename}`);
    }
}