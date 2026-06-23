import type {NoteId} from './Types.js';

/**
 * Per-turn citation. Either a vault note (target = NoteId) or an
 * external URL (target = absolute URL — used by research mode).
 */
export interface ChatSourceRef {
    /** Wikilink target — a vault note id, or a URL for research mode. */
    target: string;
    /** Display title at chat time. */
    title: string;
    /** Citation index ([^N]). */
    index: number;
    /** Retrieval score, if any. */
    score?: number;
    /** Optional snippet (for hover/expand). */
    snippet?: string;
}

export interface ChatTurn {
    role: 'user' | 'assistant';
    content: string;
    /** Model that produced an assistant turn. */
    model?: string;
    sources?: ChatSourceRef[];
}

export interface ChatSession {
    id: NoteId;
    title: string;
    /** ISO-8601 */
    createdAt: string;
    /** ISO-8601 */
    updatedAt: string;
    lastModel?: string;
    turns: ChatTurn[];
}

export interface ChatSummary {
    id: NoteId;
    title: string;
    updatedAt: string;
    lastModel?: string;
    turnCount: number;
}

/**
 * Storage port for chat sessions. Two implementations:
 * - FilesystemChatAdapter (@synaipse/service) — markdown files in
 *   <vault>/.synaipse-chats/
 * - MariaDBChatAdapter (@synaipse/server-storage, planned) — DB-backed
 *
 * Lives in core (not service) so server-storage can implement the port
 * without depending on service — see ADR
 * Memory/synaipse/decisions/2026-06-23-server-mode-architecture.md.
 */
export interface ChatAdapter {
    /**
     * Warm any in-memory state the adapter needs. Filesystem adapters
     * can leave this as a no-op (existsSync covers the sync surface);
     * DB-backed adapters use it to pre-load the id set so the sync
     * uniqueId() method has something to consult.
     */
    load(): Promise<void>;
    isLoaded(): boolean;
    list(): Promise<ChatSummary[]>;
    get(id: string): Promise<ChatSession>;
    tryGet(id: string): Promise<ChatSession | null>;
    write(session: ChatSession): Promise<void>;
    delete(id: string): Promise<void>;
    exists(id: string): Promise<boolean>;
    uniqueId(basename: string): string;
}