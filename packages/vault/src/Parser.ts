import path from 'node:path';
import matter from 'gray-matter';
import {extractTags, extractWikilinks, type Frontmatter, type Note} from '@synaipse/core';
import {sha1} from './Hash.js';

// Link/tag primitives live in @synaipse/core so the MariaDB adapter
// parses exactly like the filesystem vault. Re-exported for callers that
// historically imported them from here.
export {extractTags, extractWikilinks} from '@synaipse/core';

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