import type {ChatAdapter} from './ChatAdapter.js';
import type {ChatRepo} from './ChatRepo.js';
import type {ChatSession, ChatSummary} from './ChatStore.js';

/**
 * Thin adapter wrapping the existing disk-backed ChatRepo. Lets call
 * sites depend on ChatAdapter instead of the concrete ChatRepo class
 * so a MariaDBChatAdapter can slot in without touching the Service.
 */
export class FilesystemChatAdapter implements ChatAdapter {
    public constructor(private readonly repo: ChatRepo) {}

    public list(): Promise<ChatSummary[]> {
        return this.repo.list();
    }

    public get(id: string): Promise<ChatSession> {
        return this.repo.get(id);
    }

    public tryGet(id: string): Promise<ChatSession | null> {
        return this.repo.tryGet(id);
    }

    public write(session: ChatSession): Promise<void> {
        return this.repo.write(session);
    }

    public delete(id: string): Promise<void> {
        return this.repo.delete(id);
    }

    public exists(id: string): Promise<boolean> {
        return this.repo.exists(id);
    }

    public uniqueId(basename: string): string {
        return this.repo.uniqueId(basename);
    }
}