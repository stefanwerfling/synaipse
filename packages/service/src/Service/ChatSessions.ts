import type {ChatAdapter, Frontmatter, NoteId} from '@synaipse/core';
import {createLogger} from '@synaipse/core';
import {buildChatId, isChatNote, parseChatSession, serializeChatSession, type ChatSession, type ChatSummary, type ChatTurn} from '../ChatStore.js';
import type {NoteCore} from './NoteCore.js';
import type {NoteWriter} from './NoteWriter.js';
import type {ProjectOpts} from './Types.js';

const log = createLogger('service');

/**
 * Chat sessions. Chats are deliberately NOT vault notes: they live in
 * their own store so they don't pollute the notes list, the graph, or
 * any search index. Promoting a chat into a real vault note is an
 * explicit user action (saveAsNote).
 */
export class ChatSessions {
    public constructor(
        private readonly chats: ChatAdapter,
        private readonly core: NoteCore,
        private readonly writer: NoteWriter
    ) {}

    private get notes(): NoteCore['notes'] {
        return this.core.notes;
    }

    public async load(): Promise<void> {
        await this.chats.load();
    }

    public async list(): Promise<ChatSummary[]> {
        return this.chats.list();
    }

    public async get(id: string): Promise<ChatSession> {
        return this.chats.get(id);
    }

    public async create(
        input: {title: string; lastModel?: string; turns: ChatTurn[]}
    ): Promise<ChatSession> {
        const now = new Date();
        const baseId = buildChatId(input.title, now);
        const id = this.chats.uniqueId(baseId);
        const iso = now.toISOString();

        const session: ChatSession = {
            id,
            title: input.title,
            createdAt: iso,
            updatedAt: iso,
            turns: input.turns
        };
        if (input.lastModel !== undefined) session.lastModel = input.lastModel;

        await this.chats.write(session);
        return session;
    }

    public async update(
        id: string,
        input: {title: string; lastModel?: string; turns: ChatTurn[]}
    ): Promise<ChatSession> {
        const prior = await this.chats.tryGet(id);
        if (prior === null) throw new Error(`chat not found: ${id}`);

        const session: ChatSession = {
            id,
            title: input.title,
            createdAt: prior.createdAt,
            updatedAt: new Date().toISOString(),
            turns: input.turns
        };
        if (input.lastModel !== undefined) session.lastModel = input.lastModel;

        await this.chats.write(session);
        return session;
    }

    public async delete(id: string): Promise<void> {
        await this.chats.delete(id);
    }

    /**
     * Promote a stored chat session into a real vault note. This is the
     * explicit "Save as Note" path — the source chat stays in the chat
     * store, and a copy lands in the vault where it can be searched,
     * linked, and graphed like any other note. The new note gets a
     * normal `kind: note` frontmatter so it won't be filtered out
     * anywhere.
     */
    public async saveAsNote(id: string, opts?: ProjectOpts): Promise<NoteId> {
        const session = await this.chats.get(id);
        const {content, frontmatter} = serializeChatSession(session);

        // Override kind so the saved note is a regular note, not a chat
        // (the chat store is the source of truth for chats).
        const noteFrontmatter: Frontmatter = {
            ...frontmatter,
            kind: 'note',
            tags: Array.isArray(frontmatter.tags)
                ? [...frontmatter.tags.filter((t) => t !== 'chat'), 'chat-saved']
                : ['chat-saved']
        };

        // Use the chat id (filename) as the note path, but under a
        // dedicated vault folder so saved chats stay grouped.
        const notePath = `Chats/${session.id}`;
        const note = await this.writer.writeNote(
            {path: notePath, content, frontmatter: noteFrontmatter},
            opts ?? {},
            'chat_save_as_note'
        );

        return note.id;
    }

    /**
     * One-shot migration: pre-refactor chats accidentally lived inside the
     * vault as `Chats/*.md` with `kind: chat`. Move them into the proper
     * chat store dir and delete the vault copies so they stop polluting
     * the notes list / graph / index.
     */
    public async migrateLegacyNotesOut(): Promise<{moved: number; failed: number}> {
        const legacy: NoteId[] = [];
        for (const note of this.notes.list()) {
            if (isChatNote(note)) legacy.push(note.id);
        }

        let moved = 0;
        let failed = 0;

        for (const noteId of legacy) {
            const note = this.notes.tryGet(noteId);
            if (note === undefined) continue;

            try {
                const session = parseChatSession(note);
                // Strip the "Chats/" prefix from the id so the chat store
                // uses a flat filename.
                const flatId = session.id.startsWith('Chats/')
                    ? session.id.slice('Chats/'.length)
                    : session.id;
                const safeId = this.chats.uniqueId(flatId);
                await this.chats.write({...session, id: safeId});

                // Remove from vault + bookkeeping
                await this.notes.delete(noteId, {message: `synaipse: migrate chat ${noteId} → chat store`});
                await this.core.removeIndexed(noteId);

                moved += 1;
            } catch (cause) {
                log.error('chat migration failed', {noteId, error: cause});
                failed += 1;
            }
        }

        if (moved > 0) {
            log.info('migrated legacy chat notes out of the vault into the chat store', {moved});
        }

        return {moved, failed};
    }
}
