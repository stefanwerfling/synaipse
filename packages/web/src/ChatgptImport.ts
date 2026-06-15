import JSZip from 'jszip';
import type {ChatgptImportAttachment, ChatgptImportConversation, ChatgptImportMessage} from './Api.js';

interface RawNode {
    id: string;
    message: RawMessage | null;
    parent: string | null;
    children: string[];
}

interface RawMessage {
    id: string;
    author: {role: string; name?: string};
    create_time: number | null;
    content: {
        content_type: string;
        parts?: unknown[];
        text?: string;
        language?: string;
    };
    status?: string;
    metadata?: {
        model_slug?: string;
        is_visually_hidden_from_conversation?: boolean;
    };
    recipient?: string;
}

interface RawConversation {
    id?: string;
    conversation_id?: string;
    title?: string;
    create_time?: number;
    update_time?: number;
    mapping: Record<string, RawNode>;
    current_node?: string;
    default_model_slug?: string;
}

/** Lightweight preview shown in the import dialog list. */
export interface ChatgptConversationPreview {
    id: string;
    title: string;
    createTime: number;
    updateTime: number;
    model: string | null;
    messageCount: number;
    /** First user message, truncated for the dialog preview. */
    excerpt: string;
}

const FILE_ID_RE = /(file[_-][A-Za-z0-9]+)/;

const extractFileId = (filename: string): string | null => {
    // Strip the .dat suffix so the captured ID matches the asset_pointer reference.
    const stem = filename.replace(/\.dat$/i, '').split('/').pop() ?? filename;
    const match = FILE_ID_RE.exec(stem);
    return match === null ? null : match[1] ?? null;
};

const mimeForExt = (filename: string): string | null => {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';

    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'png') return 'image/png';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'svg') return 'image/svg+xml';
    if (ext === 'pdf') return 'application/pdf';

    return null;
};

const bufferToBase64 = (buf: Uint8Array): string => {
    let bin = '';
    const chunk = 0x8000;

    for (let i = 0; i < buf.length; i += chunk) {
        bin += String.fromCharCode(...buf.subarray(i, i + chunk));
    }

    return btoa(bin);
};

const SKIP_CONTENT_TYPES = new Set([
    'tether_browsing_display',
    'tether_quote',
    'system_error',
    'execution_output',
    'reasoning_recap'
]);

interface ExtractedContent {
    text: string;
    assetPointers: string[];
}

const extractContent = (msg: RawMessage): ExtractedContent => {
    const content = msg.content;

    if (SKIP_CONTENT_TYPES.has(content.content_type)) {
        return {text: '', assetPointers: []};
    }

    if (content.content_type === 'code') {
        const code = (content.parts ?? []).filter((p): p is string => typeof p === 'string').join('\n');
        const lang = content.language ?? '';
        return {text: code.length === 0 ? '' : `\`\`\`${lang}\n${code}\n\`\`\``, assetPointers: []};
    }

    const parts = content.parts ?? [];
    const textChunks: string[] = [];
    const assetPointers: string[] = [];

    for (const part of parts) {
        if (typeof part === 'string') {
            if (part.length > 0) textChunks.push(part);
            continue;
        }

        if (typeof part !== 'object' || part === null) continue;

        const obj = part as Record<string, unknown>;

        if (typeof obj.asset_pointer === 'string') {
            assetPointers.push(obj.asset_pointer);
            continue;
        }

        if (typeof obj.text === 'string' && obj.text.length > 0) {
            textChunks.push(obj.text);
        }
    }

    return {text: textChunks.join('\n\n'), assetPointers};
};

const mapAuthorRole = (role: string): ChatgptImportMessage['role'] | null => {
    if (role === 'user') return 'user';
    if (role === 'assistant') return 'assistant';
    if (role === 'system') return 'system';
    return null;
};

const linearizeBranch = (mapping: Record<string, RawNode>, leaf: string): RawNode[] => {
    const chain: RawNode[] = [];
    const seen = new Set<string>();
    let cursor: string | null = leaf;

    while (cursor !== null && !seen.has(cursor)) {
        seen.add(cursor);
        const node: RawNode | undefined = mapping[cursor];

        if (node === undefined) break;

        chain.push(node);
        cursor = node.parent;
    }

    return chain.reverse();
};

/** Walk longest chain from root if current_node is missing/broken. */
const findLongestLeaf = (mapping: Record<string, RawNode>): string | null => {
    const depth = new Map<string, number>();

    const walk = (id: string): number => {
        const cached = depth.get(id);
        if (cached !== undefined) return cached;

        const node = mapping[id];
        if (node === undefined) return 0;

        let best = 0;
        for (const child of node.children) {
            best = Math.max(best, walk(child));
        }

        const d = 1 + best;
        depth.set(id, d);
        return d;
    };

    let bestLeaf: string | null = null;
    let bestDepth = -1;

    for (const [id, n] of Object.entries(mapping)) {
        if (n.children.length === 0) {
            const d = walk(id);
            if (d > bestDepth) {
                bestDepth = d;
                bestLeaf = id;
            }
        }
    }

    return bestLeaf;
};

interface NormalizedConversation {
    id: string;
    title: string;
    createTime: number;
    updateTime: number;
    model: string | null;
    /** Linearized messages with referenced asset pointers, before attachment lookup. */
    messages: Array<{
        role: ChatgptImportMessage['role'];
        text: string;
        createTime: number | null;
        assetPointers: string[];
    }>;
}

const normalizeConversation = (raw: RawConversation): NormalizedConversation | null => {
    const id = raw.id ?? raw.conversation_id;
    if (typeof id !== 'string' || id.length === 0) return null;

    const leaf = raw.current_node ?? findLongestLeaf(raw.mapping);
    if (leaf === null) return null;

    const chain = linearizeBranch(raw.mapping, leaf);
    const messages: NormalizedConversation['messages'] = [];
    const modelCounts = new Map<string, number>();

    for (const node of chain) {
        const msg = node.message;
        if (msg === null) continue;
        if (msg.metadata?.is_visually_hidden_from_conversation === true) continue;

        const role = mapAuthorRole(msg.author.role);
        if (role === null) continue;
        // Tool/system filter for visible chat: keep user + assistant, drop the rest.
        if (role === 'system') continue;

        const {text, assetPointers} = extractContent(msg);
        if (text.length === 0 && assetPointers.length === 0) continue;

        if (role === 'assistant') {
            const slug = msg.metadata?.model_slug;
            if (typeof slug === 'string' && slug.length > 0) {
                modelCounts.set(slug, (modelCounts.get(slug) ?? 0) + 1);
            }
        }

        messages.push({
            role,
            text,
            createTime: msg.create_time,
            assetPointers
        });
    }

    let model: string | null = raw.default_model_slug ?? null;
    let bestCount = 0;
    for (const [slug, count] of modelCounts.entries()) {
        if (count > bestCount) {
            bestCount = count;
            model = slug;
        }
    }

    return {
        id,
        title: raw.title ?? 'Untitled chat',
        createTime: raw.create_time ?? 0,
        updateTime: raw.update_time ?? raw.create_time ?? 0,
        model,
        messages
    };
};

export interface ParsedExport {
    conversations: NormalizedConversation[];
    /** Map of file ID (e.g. file-XYZ) → ZIP entry path. */
    fileIndex: Map<string, string>;
    /** Map of file ID → real filename inside the export (e.g. "image.png"). */
    fileNames: Map<string, string>;
    zip: JSZip;
}

const collectConversationFiles = (zip: JSZip): string[] => {
    const single = zip.file('conversations.json');
    if (single !== null) return ['conversations.json'];

    const chunked: string[] = [];

    zip.forEach((relPath, entry) => {
        if (entry.dir) return;
        if (/^conversations-\d+\.json$/i.test(relPath)) chunked.push(relPath);
    });

    chunked.sort();
    return chunked;
};

const loadAssetFileNames = async (zip: JSZip): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    const manifest = zip.file('conversation_asset_file_names.json');
    if (manifest === null) return out;

    try {
        const parsed = JSON.parse(await manifest.async('string')) as unknown;

        if (typeof parsed !== 'object' || parsed === null) return out;

        for (const [zipName, realName] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof realName !== 'string') continue;
            const fileId = extractFileId(zipName);
            if (fileId !== null) out.set(fileId, realName);
        }
    } catch {
        // ignore malformed manifest — we'll fall back to extension sniffing
    }

    return out;
};

export const parseChatgptExport = async (file: File): Promise<ParsedExport> => {
    const zip = await JSZip.loadAsync(file);
    const convFiles = collectConversationFiles(zip);

    if (convFiles.length === 0) {
        throw new Error('No conversations.json or conversations-NNN.json found in ZIP');
    }

    const conversations: NormalizedConversation[] = [];

    for (const name of convFiles) {
        const entry = zip.file(name);
        if (entry === null) continue;

        const raw = JSON.parse(await entry.async('string')) as unknown;
        if (!Array.isArray(raw)) continue;

        for (const item of raw) {
            if (typeof item !== 'object' || item === null) continue;
            const norm = normalizeConversation(item as RawConversation);
            if (norm !== null && norm.messages.length > 0) conversations.push(norm);
        }
    }

    conversations.sort((a, b) => b.updateTime - a.updateTime);

    const fileNames = await loadAssetFileNames(zip);
    const fileIndex = new Map<string, string>();

    zip.forEach((relPath, entry) => {
        if (entry.dir) return;
        if (relPath.endsWith('.json') || relPath.endsWith('.html')) return;

        const fileId = extractFileId(relPath);
        if (fileId !== null && !fileIndex.has(fileId)) {
            fileIndex.set(fileId, relPath);
        }
    });

    return {conversations, fileIndex, fileNames, zip};
};

export const buildPreviews = (parsed: ParsedExport): ChatgptConversationPreview[] => {
    return parsed.conversations.map((c) => {
        const firstUser = c.messages.find((m) => m.role === 'user');
        const excerpt = firstUser === undefined
            ? ''
            : (firstUser.text.length > 240 ? `${firstUser.text.slice(0, 240)}…` : firstUser.text);

        return {
            id: c.id,
            title: c.title,
            createTime: c.createTime,
            updateTime: c.updateTime,
            model: c.model,
            messageCount: c.messages.length,
            excerpt
        };
    });
};

const fileIdFromPointer = (pointer: string): string | null => extractFileId(pointer);

/** Build the wire-format conversation that gets POSTed to /api/import/chatgpt. */
export const buildImportPayload = async (
    parsed: ParsedExport,
    conversationId: string
): Promise<ChatgptImportConversation | null> => {
    const conv = parsed.conversations.find((c) => c.id === conversationId);
    if (conv === undefined) return null;

    const pointerToFileId = new Map<string, string>();
    const fileIdsNeeded = new Set<string>();

    for (const msg of conv.messages) {
        for (const ptr of msg.assetPointers) {
            const fileId = fileIdFromPointer(ptr);
            if (fileId === null) continue;
            pointerToFileId.set(ptr, fileId);
            fileIdsNeeded.add(fileId);
        }
    }

    const attachments: ChatgptImportAttachment[] = [];
    const seenFileIds = new Set<string>();

    for (const [pointer, fileId] of pointerToFileId.entries()) {
        if (seenFileIds.has(fileId)) continue;
        const zipPath = parsed.fileIndex.get(fileId);
        if (zipPath === undefined) continue;

        const entry = parsed.zip.file(zipPath);
        if (entry === null) continue;

        const realName = parsed.fileNames.get(fileId) ?? zipPath.split('/').pop() ?? zipPath;
        const bytes = await entry.async('uint8array');
        attachments.push({
            assetPointer: pointer,
            filename: realName,
            mimeType: mimeForExt(realName),
            dataBase64: bufferToBase64(bytes)
        });
        seenFileIds.add(fileId);
    }

    // For pointers that share a fileId with an already-emitted attachment, copy
    // the entry with the original pointer so the server can resolve every ref.
    for (const [pointer, fileId] of pointerToFileId.entries()) {
        const already = attachments.find((a) => a.assetPointer === pointer);
        if (already !== undefined) continue;

        const sibling = attachments.find((a) => fileIdFromPointer(a.assetPointer) === fileId);
        if (sibling === undefined) continue;

        attachments.push({...sibling, assetPointer: pointer});
    }

    const messages: ChatgptImportMessage[] = conv.messages.map((m) => ({
        role: m.role,
        text: m.text,
        createTime: m.createTime,
        ...(m.assetPointers.length > 0 ? {assetPointers: m.assetPointers} : {})
    }));

    return {
        id: conv.id,
        title: conv.title,
        createTime: conv.createTime,
        updateTime: conv.updateTime,
        model: conv.model,
        messages,
        attachments
    };
};