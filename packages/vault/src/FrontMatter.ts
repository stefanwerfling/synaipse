import yaml from 'js-yaml';
import type {Frontmatter} from '@synaipse/core';

/**
 * YAML front matter of a note: read and written here, nowhere else (plan
 * G5, replaces gray-matter).
 *
 * The file format stays what gray-matter read and wrote, so existing
 * notes parse to the same data and an unchanged note is written back
 * byte for byte:
 *
 * - The block opens with `---` at the very start (after a BOM) and closes
 *   at the next line that starts with `---`. `----` does not open one.
 *   Without a closing line the rest of the file is the block.
 * - One line break after the closing line is not part of the body.
 * - YAML is js-yaml's default schema (dates become Date objects, as with
 *   gray-matter's js-yaml 3 `safeLoad`).
 * - Writing puts `---`, the YAML, `---` before the body and ends the body
 *   with a line break. Empty data writes no block.
 *
 * Deliberately different:
 *
 * - Only YAML. A word after the opening `---` (`---js`, `---json`) made
 *   gray-matter pick another parser, `js` being `eval`. Here such a file
 *   has no front matter; all of it is body.
 * - A block that is not valid YAML, or not a mapping, is not front matter
 *   either: the file is all body and `error` says why. gray-matter threw
 *   (and one such note stopped the vault from loading) or returned the
 *   string/array as "data".
 * - Nothing is cached (gray-matter kept every input it ever saw).
 * - Writing drops `undefined` values like JSON does (gray-matter threw).
 * - js-yaml 4 quotes less (URLs, text with `:`) and writes emoji as they
 *   are: 454 of the 3289 notes in the real vault would come out formatted
 *   differently, with the same values (checked with js-yaml 3 and 4), the
 *   next time they are written.
 */

export interface ParsedFrontMatter {
    data: Frontmatter;
    /** The note without its front matter block. */
    content: string;
    /** Set when the file opens like front matter but could not be read as such. */
    error?: string;
}

const OPEN = '---';
const CLOSE = '\n---';
const BOM = '﻿';

/** Lines that are only YAML comments do not make a block non-empty (as in gray-matter). */
const COMMENT_LINE = /^\s*#[^\n]+/gm;

const isMapping = (value: unknown): value is Frontmatter =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

export const parseFrontMatter = (input: string): ParsedFrontMatter => {
    const raw = input.startsWith(BOM) ? input.slice(BOM.length) : input;

    if (!raw.startsWith(OPEN) || raw.charAt(OPEN.length) === '-') {
        return {data: {}, content: raw};
    }

    let rest = raw.slice(OPEN.length);
    const eol = rest.search(/\r?\n/);
    const language = (eol === -1 ? rest : rest.slice(0, eol)).trim().toLowerCase();

    if (language !== '' && language !== 'yaml' && language !== 'yml') {
        return {data: {}, content: raw, error: `front matter language "${language}" is not supported (only YAML)`};
    }

    rest = eol === -1 ? '' : rest.slice(eol);

    let close = rest.indexOf(CLOSE);
    if (close === -1) close = rest.length;

    const block = rest.slice(0, close);
    let content = rest.slice(close + CLOSE.length);
    if (close === rest.length) content = '';
    if (content.startsWith('\r')) content = content.slice(1);
    if (content.startsWith('\n')) content = content.slice(1);

    if (block.replace(COMMENT_LINE, '').trim() === '') {
        return {data: {}, content};
    }

    let data: unknown;
    try {
        data = yaml.load(block);
    } catch (cause) {
        return {data: {}, content: raw, error: `front matter is not valid YAML: ${(cause as Error).message.split('\n')[0]}`};
    }

    if (!isMapping(data)) {
        return {data: {}, content: raw, error: 'front matter is not a YAML mapping'};
    }

    return {data, content};
};

const withNewline = (s: string): string => (s.endsWith('\n') ? s : `${s}\n`);

/**
 * The note file for `content` with `data` as its front matter. A block
 * already at the start of `content` is merged in (its keys lose against
 * `data`), as gray-matter did: MCP clients send notes with a block in the
 * text and project tags as `data`.
 */
export const stringifyFrontMatter = (content: string, data: Frontmatter): string => {
    const own = parseFrontMatter(content);
    const merged = {...own.data, ...data};
    const block = yaml.dump(merged).trim();
    const body = withNewline(own.content);

    return block === '{}' ? body : `${OPEN}\n${block}\n${OPEN}\n${body}`;
};
