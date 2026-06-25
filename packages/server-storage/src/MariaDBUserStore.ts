import type {Pool} from 'mariadb';
import {
    type CreateUserInput,
    type CreateUserResult,
    type RotateUserResult,
    type UserRecord,
    type UserStore
} from '@synaipse/core';
import {generateToken, verifyToken} from '@synaipse/core/token-hash';
import type {ResolvedMariaDBConfig} from './Pool.js';

interface UserRow {
    id: number;
    label: string;
    token_hash: string;
    token_salt: string;
    token_hint: string;
    can_read: number;
    can_write: number;
    path_prefixes: string | object;
    tools: string | object;
    created_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
    expires_at: Date | null;
}

const parseJsonArray = (raw: string | object): string[] => {
    if (Array.isArray(raw)) {
        return raw.filter((entry): entry is string => typeof entry === 'string');
    }

    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed)
                ? parsed.filter((entry): entry is string => typeof entry === 'string')
                : [];
        } catch {
            return [];
        }
    }

    return [];
};

const rowToRecord = (row: UserRow): UserRecord => ({
    id: row.id,
    label: row.label,
    read: row.can_read === 1,
    write: row.can_write === 1,
    pathPrefixes: parseJsonArray(row.path_prefixes),
    tools: parseJsonArray(row.tools),
    tokenHint: row.token_hint,
    createdAt: row.created_at.getTime(),
    lastUsedAt: row.last_used_at?.getTime() ?? null,
    revokedAt: row.revoked_at?.getTime() ?? null,
    expiresAt: row.expires_at?.getTime() ?? null
});

export class MariaDBUserStore implements UserStore {
    public constructor(
        private readonly pool: Pool,
        private readonly config: ResolvedMariaDBConfig
    ) {}

    public async createUser(input: CreateUserInput): Promise<CreateUserResult> {
        const {plain, hashHex, saltHex, hint} = generateToken();
        const pathPrefixes = JSON.stringify(input.pathPrefixes ?? []);
        const tools = JSON.stringify(input.tools ?? []);
        const expiresAt = input.expiresAt !== undefined && input.expiresAt !== null
            ? new Date(input.expiresAt)
            : null;

        const conn = await this.pool.getConnection();

        try {
            const result = await conn.query(
                `INSERT INTO users
                    (vault_id, label, token_hash, token_salt, token_hint, can_read, can_write, path_prefixes, tools, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    this.config.vaultId,
                    input.label,
                    hashHex,
                    saltHex,
                    hint,
                    input.read ? 1 : 0,
                    input.write ? 1 : 0,
                    pathPrefixes,
                    tools,
                    expiresAt
                ]
            );

            const rows = await conn.query<UserRow[]>(
                'SELECT * FROM users WHERE id = ?',
                [result.insertId]
            );

            const row = rows[0];
            if (row === undefined) {
                throw new Error('user insert succeeded but row not readable');
            }

            return {user: rowToRecord(row), plainToken: plain};
        } finally {
            await conn.release();
        }
    }

    public async findByToken(plainToken: string): Promise<UserRecord | null> {
        if (plainToken.length < 8) {
            return null;
        }

        const hint = plainToken.slice(0, 8);
        const conn = await this.pool.getConnection();

        try {
            const rows = await conn.query<UserRow[]>(
                `SELECT * FROM users
                  WHERE vault_id = ?
                    AND token_hint = ?
                    AND revoked_at IS NULL
                    AND (expires_at IS NULL OR expires_at > NOW())`,
                [this.config.vaultId, hint]
            );

            for (const row of rows) {
                if (verifyToken(plainToken, row.token_hash, row.token_salt)) {
                    return rowToRecord(row);
                }
            }

            return null;
        } finally {
            await conn.release();
        }
    }

    public async listUsers(): Promise<UserRecord[]> {
        const conn = await this.pool.getConnection();

        try {
            const rows = await conn.query<UserRow[]>(
                'SELECT * FROM users WHERE vault_id = ? ORDER BY id ASC',
                [this.config.vaultId]
            );

            return rows.map(rowToRecord);
        } finally {
            await conn.release();
        }
    }

    public async revokeByLabel(label: string): Promise<boolean> {
        const conn = await this.pool.getConnection();

        try {
            const result = await conn.query(
                `UPDATE users
                    SET revoked_at = CURRENT_TIMESTAMP
                  WHERE vault_id = ? AND label = ? AND revoked_at IS NULL`,
                [this.config.vaultId, label]
            );

            return result.affectedRows > 0;
        } finally {
            await conn.release();
        }
    }

    public async rotateByLabel(label: string, expiresAt?: number | null): Promise<RotateUserResult | null> {
        const {plain, hashHex, saltHex, hint} = generateToken();
        const expires = expiresAt !== undefined && expiresAt !== null
            ? new Date(expiresAt)
            : null;

        const conn = await this.pool.getConnection();

        try {
            const result = await conn.query(
                `UPDATE users
                    SET token_hash = ?, token_salt = ?, token_hint = ?,
                        last_used_at = NULL, revoked_at = NULL, expires_at = ?
                  WHERE vault_id = ? AND label = ?`,
                [hashHex, saltHex, hint, expires, this.config.vaultId, label]
            );

            if (result.affectedRows === 0) {
                return null;
            }

            const rows = await conn.query<UserRow[]>(
                'SELECT * FROM users WHERE vault_id = ? AND label = ?',
                [this.config.vaultId, label]
            );

            const row = rows[0];
            if (row === undefined) {
                throw new Error('user update succeeded but row not readable');
            }

            return {user: rowToRecord(row), plainToken: plain};
        } finally {
            await conn.release();
        }
    }

    public async touchLastUsed(id: number): Promise<void> {
        const conn = await this.pool.getConnection();

        try {
            await conn.query(
                'UPDATE users SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?',
                [id]
            );
        } finally {
            await conn.release();
        }
    }

    public async close(): Promise<void> {
        // Pool lifecycle is owned by the bundle, not the individual store.
    }
}