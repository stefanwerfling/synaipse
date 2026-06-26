import type {Pool} from 'mariadb';
import type {AccountStore, ChatAdapter, NoteAdapter, UserStore} from '@synaipse/core';
import {MariaDBAccountStore} from './MariaDBAccountStore.js';
import {MariaDBChatAdapter} from './MariaDBChatAdapter.js';
import {MariaDBNoteAdapter} from './MariaDBNoteAdapter.js';
import {MariaDBUserStore} from './MariaDBUserStore.js';
import {applyMigrations, createPool, resolveConfig, type MariaDBConfig} from './Pool.js';

export interface ServerAdapterBundle {
    notes: NoteAdapter;
    chats: ChatAdapter;
    users: UserStore;
    accounts: AccountStore;
    pool: Pool;
    /**
     * Closes the underlying connection pool. Call this during shutdown
     * so the Node process can exit cleanly.
     */
    close(): Promise<void>;
}

/**
 * Boot helper for Server-Mode callers (web server, mcp-server). Builds
 * the pool, applies pending migrations, and returns NoteAdapter +
 * ChatAdapter instances ready to be passed into the Service
 * constructor's `overrides` parameter. The Service's own start() will
 * call load() on each adapter.
 */
export const createServerAdapters = async (cfg: MariaDBConfig): Promise<ServerAdapterBundle> => {
    const resolved = resolveConfig(cfg);
    const pool = createPool(resolved);

    try {
        await applyMigrations(pool);
    } catch (err) {
        await pool.end();
        throw err;
    }

    const notes = new MariaDBNoteAdapter(pool, resolved);
    const chats = new MariaDBChatAdapter(pool, resolved);
    const users = new MariaDBUserStore(pool, resolved);
    const accounts = new MariaDBAccountStore(pool, resolved);

    return {
        notes,
        chats,
        users,
        accounts,
        pool,
        close: () => pool.end()
    };
};