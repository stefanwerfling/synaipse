import type {Pool} from 'mariadb';
import {
    type AccountRecord,
    type AccountStore,
    type CreateAccountInput
} from '@synaipse/core';
import {generatePasswordHash, verifyPassword} from '@synaipse/core/password-hash';
import type {ResolvedMariaDBConfig} from './Pool.js';

interface AccountRow {
    id: number;
    email: string;
    password_hash: string;
    password_salt: string;
    is_admin: number;
    created_at: Date;
    last_login_at: Date | null;
    disabled_at: Date | null;
}

const rowToRecord = (row: AccountRow): AccountRecord => ({
    id: row.id,
    email: row.email,
    isAdmin: row.is_admin === 1,
    createdAt: row.created_at.getTime(),
    lastLoginAt: row.last_login_at?.getTime() ?? null,
    disabledAt: row.disabled_at?.getTime() ?? null
});

export class MariaDBAccountStore implements AccountStore {
    public constructor(
        private readonly pool: Pool,
        private readonly config: ResolvedMariaDBConfig
    ) {}

    public async create(input: CreateAccountInput): Promise<AccountRecord> {
        const {hashHex, saltHex} = generatePasswordHash(input.password);
        const conn = await this.pool.getConnection();

        try {
            const result = await conn.query(
                `INSERT INTO accounts
                    (vault_id, email, password_hash, password_salt, is_admin)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    this.config.vaultId,
                    input.email,
                    hashHex,
                    saltHex,
                    input.isAdmin === true ? 1 : 0
                ]
            );

            const rows = await conn.query<AccountRow[]>(
                'SELECT * FROM accounts WHERE id = ?',
                [result.insertId]
            );

            const row = rows[0];
            if (row === undefined) {
                throw new Error('account insert succeeded but row not readable');
            }

            return rowToRecord(row);
        } finally {
            await conn.release();
        }
    }

    public async findByEmail(email: string): Promise<AccountRecord | null> {
        const conn = await this.pool.getConnection();

        try {
            const rows = await conn.query<AccountRow[]>(
                'SELECT * FROM accounts WHERE vault_id = ? AND email = ?',
                [this.config.vaultId, email]
            );

            const row = rows[0];
            return row === undefined ? null : rowToRecord(row);
        } finally {
            await conn.release();
        }
    }

    public async findById(id: number): Promise<AccountRecord | null> {
        const conn = await this.pool.getConnection();

        try {
            const rows = await conn.query<AccountRow[]>(
                'SELECT * FROM accounts WHERE vault_id = ? AND id = ?',
                [this.config.vaultId, id]
            );

            const row = rows[0];
            return row === undefined ? null : rowToRecord(row);
        } finally {
            await conn.release();
        }
    }

    public async verifyLogin(email: string, password: string): Promise<AccountRecord | null> {
        const conn = await this.pool.getConnection();

        try {
            const rows = await conn.query<AccountRow[]>(
                'SELECT * FROM accounts WHERE vault_id = ? AND email = ?',
                [this.config.vaultId, email]
            );

            const row = rows[0];
            if (row === undefined) {
                return null;
            }

            if (row.disabled_at !== null) {
                return null;
            }

            if (!verifyPassword(password, row.password_hash, row.password_salt)) {
                return null;
            }

            return rowToRecord(row);
        } finally {
            await conn.release();
        }
    }

    public async listAccounts(): Promise<AccountRecord[]> {
        const conn = await this.pool.getConnection();

        try {
            const rows = await conn.query<AccountRow[]>(
                'SELECT * FROM accounts WHERE vault_id = ? ORDER BY id ASC',
                [this.config.vaultId]
            );

            return rows.map(rowToRecord);
        } finally {
            await conn.release();
        }
    }

    public async setDisabled(id: number, disabled: boolean): Promise<boolean> {
        const conn = await this.pool.getConnection();

        try {
            const result = await conn.query(
                `UPDATE accounts
                    SET disabled_at = ?
                  WHERE vault_id = ? AND id = ?`,
                [disabled ? new Date() : null, this.config.vaultId, id]
            );

            return result.affectedRows > 0;
        } finally {
            await conn.release();
        }
    }

    public async setAdmin(id: number, isAdmin: boolean): Promise<boolean> {
        const conn = await this.pool.getConnection();

        try {
            const result = await conn.query(
                `UPDATE accounts
                    SET is_admin = ?
                  WHERE vault_id = ? AND id = ?`,
                [isAdmin ? 1 : 0, this.config.vaultId, id]
            );

            return result.affectedRows > 0;
        } finally {
            await conn.release();
        }
    }

    public async setPassword(id: number, password: string): Promise<boolean> {
        const {hashHex, saltHex} = generatePasswordHash(password);
        const conn = await this.pool.getConnection();

        try {
            const result = await conn.query(
                `UPDATE accounts
                    SET password_hash = ?, password_salt = ?
                  WHERE vault_id = ? AND id = ?`,
                [hashHex, saltHex, this.config.vaultId, id]
            );

            return result.affectedRows > 0;
        } finally {
            await conn.release();
        }
    }

    public async touchLastLogin(id: number): Promise<void> {
        const conn = await this.pool.getConnection();

        try {
            await conn.query(
                'UPDATE accounts SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?',
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