import type {ChatSession, ChatSummary} from './ChatStore.js';

/**
 * Storage port for chat sessions. Two implementations:
 * - FilesystemChatAdapter (wraps ChatRepo) — markdown files in
 *   <vault>/.synaipse-chats/
 * - MariaDBChatAdapter (@synaipse/server-storage, planned) — DB-backed
 *
 * See Memory/synaipse/decisions/2026-06-23-server-mode-architecture.md.
 */
export interface ChatAdapter {
    list(): Promise<ChatSummary[]>;
    get(id: string): Promise<ChatSession>;
    tryGet(id: string): Promise<ChatSession | null>;
    write(session: ChatSession): Promise<void>;
    delete(id: string): Promise<void>;
    exists(id: string): Promise<boolean>;
    uniqueId(basename: string): string;
}