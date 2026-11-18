import type {NoteId} from '@synaipse/core';
import {wordsOf} from './Duplicates.js';

/**
 * The `remember` inbox (Memory/<project>/inbox/YYYY-MM-DD.md, one
 * `### HH:MM` block per entry, tags as a trailing `#tag` line) and helpers
 * to point an agent at the right place in a note (plan P8 / B4, B3).
 */

export interface InboxEntry {
    /** The inbox note. */
    inbox: NoteId;
    /** YYYY-MM-DD from the file name. */
    date: string;
    /** The entry heading, `HH:MM` (read_note `section` takes it). */
    time: string;
    text: string;
    tags: string[];
}

const INBOX_FILE = /(?:^|\/)inbox\/(\d{4}-\d{2}-\d{2})\.md$/;
const TAG_LINE = /^(?:#[\p{L}\p{N}_/-]+\s*)+$/u;

export const isInboxNote = (id: NoteId): boolean => INBOX_FILE.test(id);

/** Entries of one inbox note in file order; text without the tag line. */
export const parseInbox = (id: NoteId, content: string): InboxEntry[] => {
    const date = INBOX_FILE.exec(id)?.[1];
    if (date === undefined) return [];

    const entries: InboxEntry[] = [];
    const blocks = content.split(/^###\s+/m).slice(1);

    for (const block of blocks) {
        const newline = block.indexOf('\n');
        const time = (newline === -1 ? block : block.slice(0, newline)).trim();
        const lines = (newline === -1 ? '' : block.slice(newline + 1)).trim().split('\n');

        let tags: string[] = [];
        const last = lines[lines.length - 1]?.trim() ?? '';
        if (lines.length > 1 && TAG_LINE.test(last)) {
            tags = last.split(/\s+/).map((t) => t.replace(/^#/, ''));
            lines.pop();
        }

        const text = lines.join('\n').trim();
        if (text.length > 0) entries.push({inbox: id, date, time, text, tags});
    }

    return entries;
};

export interface SectionAnchor {
    /** Heading text, as read_note `section` expects it. */
    section: string;
    /** 1-based first and last line of the section in the note body. */
    lines: [number, number];
}

/**
 * The heading section of `content` that mentions the query words most
 * often; null when the note has fewer than two sections (reading the
 * section would not save anything) or no section mentions any of them.
 */
export const bestSection = (content: string, query: string): SectionAnchor | null => {
    const terms = wordsOf(query);
    if (terms.size === 0) return null;

    const lines = content.split('\n');
    const starts: Array<{line: number; heading: string}> = [];
    let fence = false;

    lines.forEach((line, i) => {
        if (/^\s*(```|~~~)/.test(line)) fence = !fence;
        const m = fence ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
        if (m !== null) starts.push({line: i, heading: m[1]!});
    });

    if (starts.length < 2) return null;

    let best: SectionAnchor | null = null;
    let bestScore = 0;

    starts.forEach((start, k) => {
        const end = (starts[k + 1]?.line ?? lines.length) - 1;
        let score = 0;

        for (let i = start.line; i <= end; i++) {
            for (const word of (lines[i] ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
                if (terms.has(word)) score++;
            }
        }

        if (score > bestScore) {
            bestScore = score;
            best = {section: start.heading, lines: [start.line + 1, end + 1]};
        }
    });

    return best;
};
