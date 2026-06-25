import {
    generateToken,
    verifyToken,
    type CreateUserInput,
    type CreateUserResult,
    type UserRecord,
    type UserStore
} from '@synaipse/core';

interface Row extends UserRecord {
    hashHex: string;
    saltHex: string;
}

/**
 * Drop-in UserStore for tests that exercise resolveTokenScope's userStore
 * path without touching MariaDB. Behaves like MariaDBUserStore at the
 * port boundary but holds rows in a Map.
 */
export class InMemoryUserStore implements UserStore {
    private readonly rows = new Map<number, Row>();
    private nextId = 1;

    public async createUser(input: CreateUserInput): Promise<CreateUserResult> {
        const {plain, hashHex, saltHex, hint} = generateToken();
        const id = this.nextId++;

        const row: Row = {
            id,
            label: input.label,
            read: input.read,
            write: input.write,
            pathPrefixes: input.pathPrefixes ?? [],
            tools: input.tools ?? [],
            tokenHint: hint,
            createdAt: Date.now(),
            lastUsedAt: null,
            revokedAt: null,
            hashHex,
            saltHex
        };

        this.rows.set(id, row);
        return {user: this.toRecord(row), plainToken: plain};
    }

    public async findByToken(plainToken: string): Promise<UserRecord | null> {
        if (plainToken.length < 8) return null;
        const hint = plainToken.slice(0, 8);

        for (const row of this.rows.values()) {
            if (row.revokedAt !== null) continue;
            if (row.tokenHint !== hint) continue;
            if (verifyToken(plainToken, row.hashHex, row.saltHex)) {
                return this.toRecord(row);
            }
        }

        return null;
    }

    public async listUsers(): Promise<UserRecord[]> {
        return [...this.rows.values()].map((r) => this.toRecord(r));
    }

    public async revokeByLabel(label: string): Promise<boolean> {
        for (const row of this.rows.values()) {
            if (row.label === label && row.revokedAt === null) {
                row.revokedAt = Date.now();
                return true;
            }
        }
        return false;
    }

    public async touchLastUsed(id: number): Promise<void> {
        const row = this.rows.get(id);
        if (row !== undefined) {
            row.lastUsedAt = Date.now();
        }
    }

    public async close(): Promise<void> {
        // nothing to release
    }

    private toRecord(row: Row): UserRecord {
        return {
            id: row.id,
            label: row.label,
            read: row.read,
            write: row.write,
            pathPrefixes: row.pathPrefixes,
            tools: row.tools,
            tokenHint: row.tokenHint,
            createdAt: row.createdAt,
            lastUsedAt: row.lastUsedAt,
            revokedAt: row.revokedAt
        };
    }
}