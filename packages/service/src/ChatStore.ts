import type {
    ChatSession,
    ChatSourceRef,
    ChatSummary,
    ChatTurn,
    Frontmatter,
    Note
} from '@synaipse/core';

export type {ChatSession, ChatSourceRef, ChatSummary, ChatTurn};

/**
 * Persistent chat sessions live in `vault/Chats/<id>.md`. The body is
 * human-readable markdown so the file renders as a real note, the
 * trailing wikilinks per assistant turn let the vault crawler build
 * backlinks (so the cited notes link back to the chat — closing the
 * circle), and the structured metadata needed to *resume* a chat
 * lives in HTML-comment markers that don't affect rendering.
 *
 * Per-turn marker grammar:
 *   <!--chat:user-->                              (opens a user turn)
 *   <!--chat:assistant model="..." sources='...'--> (opens an assistant turn)
 *
 * The next marker — or EOF — ends the current turn.
 *
 * The session/turn/source type shapes themselves live in @synaipse/core
 * so storage adapters in @synaipse/server-storage can implement the
 * ChatAdapter port without depending on @synaipse/service.
 */

// Allow ANY character in the attrs (including `>` and newlines) because the
// `sources` JSON payload regularly contains blockquote chars (`> ` in
// snippets) and other markdown noise. Non-greedy + dot-all ensures we
// still stop at the first `-->` after the marker open.
const TURN_MARKER_RE = /<!--chat:(user|assistant)(?:\s+([\s\S]*?))?-->/g;
const TRAILING_WIKILINKS_RE = /\n+(?:\[\[[^\]]+\]\](?:\s*·\s*\[\[[^\]]+\]\])*)\s*$/;

const escapeAttr = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const unescapeAttr = (s: string): string =>
    s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const parseAttrs = (raw: string): {model?: string; sources?: ChatSourceRef[]} => {
    const out: {model?: string; sources?: ChatSourceRef[]} = {};

    // model="..." (double-quoted, no embedded quotes)
    const model = raw.match(/\bmodel="([^"]*)"/);
    if (model?.[1] !== undefined) out.model = unescapeAttr(model[1]);

    // sources='...' (single-quoted JSON). Greedy `[\s\S]*` so source
    // snippets containing apostrophes (e.g. `'node-fuse-bindings'`,
    // `it's`) don't truncate the value at the first inner `'`.
    // The match goes up to the LAST `'` on the attr line, which is the
    // attribute terminator.
    const sources = raw.match(/\bsources='([\s\S]*)'/);
    if (sources?.[1] !== undefined) {
        // Future serialised payloads encode `'` as `'` to avoid
        // collisions with the attr delimiter — decode that back to `'`
        // so JSON.parse sees the original string.
        const rawJson = sources[1].replace(/\\u0027/g, "'");
        try {
            const parsed = JSON.parse(rawJson) as unknown;
            if (Array.isArray(parsed)) {
                out.sources = parsed.filter((s): s is ChatSourceRef =>
                    typeof s === 'object'
                    && s !== null
                    && typeof (s as ChatSourceRef).target === 'string'
                    && typeof (s as ChatSourceRef).title === 'string'
                    && typeof (s as ChatSourceRef).index === 'number'
                );
            }
        } catch {
            // malformed — skip rather than throw
        }
    }

    return out;
};

const stripTrailingWikilinks = (content: string): string => {
    return content.replace(TRAILING_WIKILINKS_RE, '').trim();
};

export interface SerializedChat {
    content: string;
    frontmatter: Frontmatter;
}

export const serializeChatSession = (session: ChatSession): SerializedChat => {
    const lines: string[] = [];
    const allSources = new Set<string>();

    for (const turn of session.turns) {
        const attrs: string[] = [];

        if (turn.role === 'assistant') {
            if (turn.model !== undefined) {
                attrs.push(`model="${escapeAttr(turn.model)}"`);
            }
            if (turn.sources !== undefined && turn.sources.length > 0) {
                const payload = turn.sources.map((s) => {
                    const o: Record<string, unknown> = {
                        target: s.target,
                        title: s.title,
                        index: s.index
                    };
                    if (s.score !== undefined) o.score = s.score;
                    if (s.snippet !== undefined) o.snippet = s.snippet;
                    return o;
                });
                // Encode `'` so apostrophes in snippets don't collide with
                // the attr delimiter. Greedy parser also tolerates raw
                // apostrophes from legacy files, but new writes are clean.
                const json = JSON.stringify(payload).replace(/'/g, '\\u0027');
                attrs.push(`sources='${json}'`);
            }
        }

        const marker = attrs.length > 0
            ? `<!--chat:${turn.role} ${attrs.join(' ')}-->`
            : `<!--chat:${turn.role}-->`;

        lines.push(marker);
        lines.push('');
        lines.push(turn.content.trim());

        // Trailing wikilinks line so the vault crawler picks up
        // backlinks. Only emit for in-vault targets (skip URLs from
        // research mode).
        if (turn.role === 'assistant' && turn.sources !== undefined && turn.sources.length > 0) {
            const vaultRefs = turn.sources.filter((s) => !/^https?:\/\//.test(s.target));
            if (vaultRefs.length > 0) {
                lines.push('');
                lines.push(vaultRefs.map((s) => `[[${s.target}]]`).join(' · '));
                for (const s of vaultRefs) allSources.add(s.target);
            }
        }

        lines.push('');
    }

    const frontmatter: Frontmatter = {
        title: session.title,
        tags: ['chat'],
        created: session.createdAt,
        updated: session.updatedAt
    };

    frontmatter.kind = 'chat';

    if (session.lastModel !== undefined) {
        frontmatter.last_model = session.lastModel;
    }

    if (allSources.size > 0) {
        frontmatter.sources = [...allSources];
    }

    return {content: lines.join('\n'), frontmatter};
};

/**
 * Parse a note back into a ChatSession. Robust to: missing markers
 * (returns empty turns), trailing wikilink lines (stripped from
 * assistant content), and unknown attributes (ignored).
 */
export const parseChatSession = (note: Note): ChatSession => {
    const text = note.content;
    const turns: ChatTurn[] = [];

    // Find every marker, then take the slice between consecutive markers
    // as the turn's content.
    interface Marker {
        role: 'user' | 'assistant';
        attrs: {model?: string; sources?: ChatSourceRef[]};
        start: number;
        contentStart: number;
    }

    const markers: Marker[] = [];

    for (const m of text.matchAll(TURN_MARKER_RE)) {
        if (m.index === undefined) continue;
        const role = m[1] as 'user' | 'assistant';
        const attrs = parseAttrs(m[2] ?? '');
        markers.push({
            role,
            attrs,
            start: m.index,
            contentStart: m.index + m[0].length
        });
    }

    for (let i = 0; i < markers.length; i += 1) {
        const cur = markers[i];
        const next = markers[i + 1];
        if (cur === undefined) continue;

        const rawContent = text.slice(cur.contentStart, next?.start ?? text.length);
        const content = cur.role === 'assistant'
            ? stripTrailingWikilinks(rawContent)
            : rawContent.trim();

        const turn: ChatTurn = {role: cur.role, content};

        if (cur.attrs.model !== undefined) turn.model = cur.attrs.model;
        if (cur.attrs.sources !== undefined) turn.sources = cur.attrs.sources;

        turns.push(turn);
    }

    const fm = note.frontmatter;
    const lastModel = typeof fm.last_model === 'string' ? fm.last_model : undefined;
    const createdAt = typeof fm.created === 'string' ? fm.created : new Date(note.mtime).toISOString();
    const updatedAt = typeof fm.updated === 'string' ? fm.updated : new Date(note.mtime).toISOString();
    const title = typeof fm.title === 'string' && fm.title.length > 0 ? fm.title : (note.title || 'Untitled chat');

    const session: ChatSession = {
        id: note.id,
        title,
        createdAt,
        updatedAt,
        turns
    };

    if (lastModel !== undefined) session.lastModel = lastModel;

    return session;
};

/** Slugify a chat title for use as a file path component. */
export const slugifyChatTitle = (title: string, maxWords = 6): string => {
    const cleaned = title
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '') // strip diacritics
        .replace(/[^a-z0-9\s-]/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0)
        .slice(0, maxWords)
        .join('-');

    return cleaned.length > 0 ? cleaned : 'chat';
};

/**
 * Build a fresh chat id (filename, no folder). Caller is responsible
 * for ensuring uniqueness if multiple sessions might collide on the
 * same minute + slug.
 */
export const buildChatId = (title: string, now: Date): string => {
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
        + `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const slug = slugifyChatTitle(title);
    return `${stamp}-${slug}.md`;
};

export const isChatNote = (note: Note): boolean => {
    return note.frontmatter.kind === 'chat';
};

export const summarizeChat = (note: Note): ChatSummary => {
    const session = parseChatSession(note);
    return {
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        ...(session.lastModel !== undefined ? {lastModel: session.lastModel} : {}),
        turnCount: session.turns.length
    };
};