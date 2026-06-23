import type {Pool} from 'mariadb';
import type {ChatAdapter, NoteAdapter} from '@synaipse/core';
import {MariaDBChatAdapter} from './MariaDBChatAdapter.js';
import {MariaDBNoteAdapter} from './MariaDBNoteAdapter.js';
import {applyMigrations, createPool, resolveConfig, type MariaDBConfig} from './Pool.js';

export interface ServerAdapterBundle {
    notes: NoteAdapter;
    chats: ChatAdapter;
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

    return {
        notes,
        chats,
        pool,
        close: () => pool.end()
    };
};