/**
 * ChatGPT data-export importer.
 *
 * Input shape mirrors `conversations.json` from a ChatGPT export, narrowed to
 * the fields we actually consume. The browser flattens the conversation tree
 * (mapping + current_node) into a linear `messages` array before POSTing, so
 * this module never sees the raw graph.
 */

export interface ChatgptImportAttachment {
    /** Original asset pointer from the export (e.g. file-service://file-ABC). */
    assetPointer: string;
    /** Original filename in the zip — used for the asset extension. */
    filename: string;
    /** Detected mime type, or null if unknown. */
    mimeType: string | null;
    /** Base64-encoded file content. */
    dataBase64: string;
}

export interface ChatgptImportMessage {
    role: 'user' | 'assistant' | 'system';
    /** Rendered text content for this turn. */
    text: string;
    /** Unix seconds. */
    createTime: number | null;
    /** Asset pointers referenced inside this message (matched against attachments). */
    assetPointers?: string[];
}

export interface ChatgptImportConversation {
    /** ChatGPT conversation UUID (frontmatter.chatgpt_id). */
    id: string;
    title: string;
    /** Unix seconds (float). */
    createTime: number;
    updateTime: number;
    /** Dominant assistant model_slug, if any. */
    model: string | null;
    messages: ChatgptImportMessage[];
    attachments: ChatgptImportAttachment[];
}

const slugify = (input: string): string => {
    const fallback = 'chat';
    const out = input
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);

    return out.length === 0 ? fallback : out;
};

const formatDate = (unixSeconds: number): string => {
    if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) {
        return new Date().toISOString().slice(0, 10);
    }

    return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
};

const formatDateTime = (unixSeconds: number | null): string | null => {
    if (unixSeconds === null || !Number.isFinite(unixSeconds) || unixSeconds <= 0) {
        return null;
    }

    return new Date(unixSeconds * 1000).toISOString();
};

const roleHeading = (role: ChatgptImportMessage['role'], model: string | null): string => {
    if (role === 'user') return '## You';
    if (role === 'assistant') return model === null ? '## ChatGPT' : `## ChatGPT (${model})`;
    return '## System';
};

export interface ChatgptRenderResult {
    /** Vault-relative path (without project prefix) where the note should live. */
    pathHint: string;
    content: string;
    frontmatter: Record<string, unknown>;
}

/**
 * Build the markdown body + frontmatter for one ChatGPT conversation. The
 * `assetPathFor` callback maps original asset pointers (e.g. file-service://…)
 * to a markdown-ready relative path that should appear inside ![](…). When an
 * asset is missing, the pointer is rendered as italic placeholder text instead.
 */
export const renderChatgptConversation = (
    conv: ChatgptImportConversation,
    assetPathFor: (assetPointer: string) => string | null
): ChatgptRenderResult => {
    const slug = slugify(conv.title);
    const pathHint = `chatgpt-import/${conv.id}/${slug}.md`;

    const lines: string[] = [];
    lines.push(`# ${conv.title || 'Untitled chat'}`, '');
    lines.push(`> Imported from ChatGPT · \`${conv.id}\``, '');

    for (const msg of conv.messages) {
        if (msg.text.trim().length === 0 && (msg.assetPointers === undefined || msg.assetPointers.length === 0)) {
            continue;
        }

        lines.push(roleHeading(msg.role, conv.model));

        const ts = formatDateTime(msg.createTime);
        if (ts !== null) {
            lines.push(`*${ts}*`, '');
        } else {
            lines.push('');
        }

        if (msg.text.trim().length > 0) {
            lines.push(msg.text.trim(), '');
        }

        if (msg.assetPointers !== undefined) {
            for (const ptr of msg.assetPointers) {
                const rel = assetPathFor(ptr);

                if (rel !== null) {
                    lines.push(`![](${rel})`, '');
                } else {
                    lines.push(`*[missing attachment: ${ptr}]*`, '');
                }
            }
        }
    }

    const frontmatter: Record<string, unknown> = {
        title: conv.title || 'Untitled chat',
        chatgpt_id: conv.id,
        source: 'chatgpt-export',
        created: formatDate(conv.createTime),
        updated: formatDate(conv.updateTime),
        tags: conv.model === null ? ['chatgpt'] : ['chatgpt', conv.model]
    };

    if (conv.model !== null) {
        frontmatter.chatgpt_model = conv.model;
    }

    return {pathHint, content: lines.join('\n'), frontmatter};
};