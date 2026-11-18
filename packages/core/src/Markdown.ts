import type {Frontmatter} from './Types.js';

/**
 * Markdown link/tag primitives shared by every NoteAdapter. Previously
 * duplicated between @synaipse/vault (Parser.ts) and @synaipse/server-storage
 * (MariaDBNoteAdapter.ts); one copy keeps both storage modes in agreement
 * about what counts as a wikilink or tag.
 *
 * Browser-safe (no node: imports) — the web frontend may import it too.
 */

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const TAG_RE = /(?:^|\s)#([A-Za-z0-9_\-/]+)/g;
const CODE_FENCE_RE = /```[\s\S]*?```|`[^`]*`/g;

export const stripCode = (markdown: string): string => markdown.replace(CODE_FENCE_RE, '');

export const extractWikilinks = (markdown: string): string[] => {
    const cleaned = stripCode(markdown);
    const links = new Set<string>();

    for (const match of cleaned.matchAll(WIKILINK_RE)) {
        if (match[1]) {
            links.add(match[1].trim());
        }
    }

    return [...links];
};

export const extractTags = (markdown: string, frontmatter: Frontmatter): string[] => {
    const tags = new Set<string>();

    if (Array.isArray(frontmatter.tags)) {
        for (const tag of frontmatter.tags) {
            if (typeof tag === 'string') {
                tags.add(tag);
            }
        }
    }

    const cleaned = stripCode(markdown);

    for (const match of cleaned.matchAll(TAG_RE)) {
        if (match[1]) {
            tags.add(match[1]);
        }
    }

    return [...tags];
};
