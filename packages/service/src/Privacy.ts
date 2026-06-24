import type {Note} from '@synaipse/core';

/**
 * DSGVO Layer 2: classify a note as "private" — must not leave the host
 * when the chat provider is external. Triggers (any one is enough):
 *
 *  - `frontmatter.private === true`
 *  - `frontmatter.dsgvo === true`
 *  - tag `private` (synaipse stores tags without the `#` prefix in
 *    `note.tags`; frontmatter `tags:` arrays follow the same convention)
 *  - path begins with `Private/`, `Personal/` or `secrets/` (matched
 *    case-insensitively so vault layout typos don't punch holes in the guard)
 *
 * Pure function — no I/O, no Service dependency. Service decides what to
 * *do* with the verdict (filter, abort, fall back to deterministic mode).
 */

const PRIVATE_PATH_PREFIXES: readonly string[] = ['private/', 'personal/', 'secrets/'];

export const isPathPrivate = (path: string): boolean => {
    const lower = path.toLowerCase();
    return PRIVATE_PATH_PREFIXES.some((p) => lower.startsWith(p));
};

const hasPrivateTag = (tags: readonly string[]): boolean => {
    return tags.some((t) => t.toLowerCase() === 'private' || t.toLowerCase() === '#private');
};

export const isNotePrivate = (note: Note): boolean => {
    if (note.frontmatter.private === true) return true;
    if (note.frontmatter.dsgvo === true) return true;
    if (hasPrivateTag(note.tags)) return true;
    if (isPathPrivate(note.path)) return true;
    if (isPathPrivate(note.id)) return true;
    return false;
};