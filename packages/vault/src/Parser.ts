import path from 'node:path';
import matter from 'gray-matter';
import type {Frontmatter, Note} from '@synaipse/core';
import {sha1} from './Hash.js';

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const TAG_RE = /(?:^|\s)#([A-Za-z0-9_\-/]+)/g;
const CODE_FENCE_RE = /```[\s\S]*?```|`[^`]*`/g;

const stripCode = (markdown: string): string => {
    return markdown.replace(CODE_FENCE_RE, '');
};

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

const noteIdFor = (vaultRoot: string, absolutePath: string): string => {
    return path.relative(vaultRoot, absolutePath).replaceAll(path.sep, '/');
};

const titleFor = (frontmatter: Frontmatter, absolutePath: string, body: string): string => {
    if (typeof frontmatter.title === 'string' && frontmatter.title.length > 0) {
        return frontmatter.title;
    }

    const heading = body.match(/^#\s+(.+)$/m);

    if (heading?.[1]) {
        return heading[1].trim();
    }

    return path.basename(absolutePath, '.md');
};

export interface ParseInput {
    vaultRoot: string;
    absolutePath: string;
    raw: string;
    mtime: number;
}

export const parseNote = (input: ParseInput): Note => {
    const parsed = matter(input.raw);
    const frontmatter = parsed.data as Frontmatter;
    const body = parsed.content;

    return {
        id: noteIdFor(input.vaultRoot, input.absolutePath),
        path: input.absolutePath,
        title: titleFor(frontmatter, input.absolutePath, body),
        content: body,
        frontmatter,
        tags: extractTags(body, frontmatter),
        wikilinks: extractWikilinks(body),
        backlinks: [],
        mtime: input.mtime,
        hash: sha1(input.raw)
    };
};