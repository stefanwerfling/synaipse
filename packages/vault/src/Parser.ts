import path from 'node:path';
import {createLogger, extractTags, extractWikilinks, type Frontmatter, type Note} from '@synaipse/core';
import {parseFrontMatter} from './FrontMatter.js';
import {sha1} from './Hash.js';

// Link/tag primitives live in @synaipse/core so the MariaDB adapter
// parses exactly like the filesystem vault. Re-exported for callers that
// historically imported them from here.
export {extractTags, extractWikilinks} from '@synaipse/core';

const log = createLogger('vault');

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
    // Never throws: a block that is not YAML front matter stays in the body,
    // so one broken note neither stops the vault from loading nor loses text.
    const parsed = parseFrontMatter(input.raw);
    if (parsed.error !== undefined) {
        log.warn('front matter ignored', {path: input.absolutePath, error: parsed.error});
    }
    const frontmatter = parsed.data;
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