import type {NoteAdapter, NoteId} from '@synaipse/core';
import type {AssetStore} from '../AssetStore.js';
import {renderChatgptConversation, type ChatgptImportConversation} from '../ChatgptImport.js';
import type {NoteWriter} from './NoteWriter.js';
import {slugifyForPath} from './Util.js';

/** Content from outside the vault: web clips and ChatGPT exports. Both are idempotent (same URL / conversation id → same note). */
export class ImportService {
    public constructor(
        private readonly notes: NoteAdapter,
        private readonly writer: NoteWriter,
        private readonly assetStore: AssetStore
    ) {}

    /** Map of ChatGPT conversation UUID → existing vault note id, scanning frontmatter.chatgpt_id. */
    public listChatgptImports(): Map<string, NoteId> {
        const out = new Map<string, NoteId>();

        for (const note of this.notes.list()) {
            const id = note.frontmatter.chatgpt_id;

            if (typeof id === 'string' && id.length > 0) {
                out.set(id, note.id);
            }
        }

        return out;
    }

    public async clipPage(input: {
        url: string;
        title: string;
        markdown: string;
        tags?: readonly string[];
        excerpt?: string;
    }): Promise<{noteId: NoteId; isUpdate: boolean}> {
        // Idempotency by URL: scan vault for an existing clip with the same source URL.
        let existingId: NoteId | undefined;

        for (const note of this.notes.list()) {
            if (note.frontmatter.source_url === input.url) {
                existingId = note.id;
                break;
            }
        }

        const now = new Date();
        const date = now.toISOString().slice(0, 10);
        const slug = slugifyForPath(input.title);
        const writePath = existingId ?? `Clipped/${date}-${slug}.md`;

        const frontmatter: Record<string, unknown> = {
            title: input.title,
            source_url: input.url,
            source: 'web-clipper',
            created: date,
            updated: date,
            tags: [...new Set(['clipped', ...(input.tags ?? [])])]
        };

        if (input.excerpt !== undefined && input.excerpt.length > 0) {
            frontmatter.excerpt = input.excerpt;
        }

        const body = `# ${input.title}\n\n> Source: <${input.url}>\n\n${input.markdown.trim()}\n`;

        const note = await this.writer.writeRaw(
            {path: writePath, content: body, frontmatter},
            `synaipse: clip ${writePath}`
        );

        return {noteId: note.id, isUpdate: existingId !== undefined};
    }

    public async importChatgptConversation(
        conv: ChatgptImportConversation
    ): Promise<{noteId: NoteId; isUpdate: boolean}> {
        const existingMap = this.listChatgptImports();
        const existingId = existingMap.get(conv.id);

        const writePath = existingId ?? `chatgpt-import/${conv.id}/${slugifyForPath(conv.title)}.md`;

        const pointerToRelative = new Map<string, string>();

        for (const att of conv.attachments) {
            const buf = Buffer.from(att.dataBase64, 'base64');
            const result = await this.assetStore.writeAsset({noteId: writePath, content: buf, contentType: att.mimeType});
            pointerToRelative.set(att.assetPointer, result.relativePath);
        }

        const rendered = renderChatgptConversation(conv, (ptr) => pointerToRelative.get(ptr) ?? null);

        const note = await this.writer.writeRaw(
            {
                path: writePath,
                content: rendered.content,
                frontmatter: rendered.frontmatter
            },
            `synaipse: import_chatgpt ${writePath}`
        );

        return {noteId: note.id, isUpdate: existingId !== undefined};
    }
}
