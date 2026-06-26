import {
    type AccountRecord,
    type AccountStore,
    type CreateAccountInput
} from '@synaipse/core';
import {generatePasswordHash, verifyPassword} from '@synaipse/core/password-hash';

interface Row extends AccountRecord {
    hashHex: string;
    saltHex: string;
}

/**
 * Drop-in AccountStore for tests that need to exercise the login or
 * admin-user-mgmt code paths without touching MariaDB. Behaves like
 * MariaDBAccountStore at the port boundary but holds rows in a Map.
 */
export class InMemoryAccountStore implements AccountStore {
    private readonly rows = new Map<number, Row>();
    private nextId = 1;

    public async create(input: CreateAccountInput): Promise<AccountRecord> {
        for (const row of this.rows.values()) {
            if (row.email === input.email) {
                throw new Error(`account with email "${input.email}" already exists`);
            }
        }

        const {hashHex, saltHex} = generatePasswordHash(input.password);
        const id = this.nextId++;

        const row: Row = {
            id,
            email: input.email,
            isAdmin: input.isAdmin === true,
            createdAt: Date.now(),
            lastLoginAt: null,
            disabledAt: null,
            hashHex,
            saltHex
        };

        this.rows.set(id, row);
        return this.toRecord(row);
    }

    public async findByEmail(email: string): Promise<AccountRecord | null> {
        for (const row of this.rows.values()) {
            if (row.email === email) return this.toRecord(row);
        }
        return null;
    }

    public async findById(id: number): Promise<AccountRecord | null> {
        const row = this.rows.get(id);
        return row === undefined ? null : this.toRecord(row);
    }

    public async verifyLogin(email: string, password: string): Promise<AccountRecord | null> {
        for (const row of this.rows.values()) {
            if (row.email !== email) continue;
            if (row.disabledAt !== null) return null;
            if (!verifyPassword(password, row.hashHex, row.saltHex)) return null;
            return this.toRecord(row);
        }
        return null;
    }

    public async listAccounts(): Promise<AccountRecord[]> {
        return [...this.rows.values()].map((r) => this.toRecord(r));
    }

    public async setDisabled(id: number, disabled: boolean): Promise<boolean> {
        const row = this.rows.get(id);
        if (row === undefined) return false;
        row.disabledAt = disabled ? Date.now() : null;
        return true;
    }

    public async setAdmin(id: number, isAdmin: boolean): Promise<boolean> {
        const row = this.rows.get(id);
        if (row === undefined) return false;
        row.isAdmin = isAdmin;
        return true;
    }

    public async setPassword(id: number, password: string): Promise<boolean> {
        const row = this.rows.get(id);
        if (row === undefined) return false;
        const {hashHex, saltHex} = generatePasswordHash(password);
        row.hashHex = hashHex;
        row.saltHex = saltHex;
        return true;
    }

    public async touchLastLogin(id: number): Promise<void> {
        const row = this.rows.get(id);
        if (row !== undefined) {
            row.lastLoginAt = Date.now();
        }
    }

    public async close(): Promise<void> {
        // nothing to release
    }

    private toRecord(row: Row): AccountRecord {
        return {
            id: row.id,
            email: row.email,
            isAdmin: row.isAdmin,
            createdAt: row.createdAt,
            lastLoginAt: row.lastLoginAt,
            disabledAt: row.disabledAt
        };
    }
}