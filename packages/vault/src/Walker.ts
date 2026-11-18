import {readdir} from 'node:fs/promises';
import path from 'node:path';

// Shared with Watcher.ts. `.synaipse*` covers every sidecar (`.synaipse/`
// with the SQLite state DB, `.synaipse-chats/`, …), `.ngit/` holds the
// version history — none of them contains notes.
const IGNORED_DIRS = new Set(['.git', '.ngit', '.obsidian', 'node_modules', '.trash']);

/** True for directory names that are never part of the vault's notes. */
export const isIgnoredDir = (name: string): boolean => IGNORED_DIRS.has(name) || name.startsWith('.synaipse');

/** True when any segment of `p` is an ignored directory. */
export const isIgnoredPath = (p: string): boolean => p.split(/[\\/]/).some(isIgnoredDir);

export async function* walkMarkdown(root: string): AsyncIterableIterator<string> {
    const entries = await readdir(root, {withFileTypes: true});

    for (const entry of entries) {
        const full = path.join(root, entry.name);

        if (entry.isDirectory()) {
            if (isIgnoredDir(entry.name)) {
                continue;
            }

            yield* walkMarkdown(full);
            continue;
        }

        if (entry.isFile() && entry.name.endsWith('.md')) {
            yield full;
        }
    }
}

export async function* walkCanvas(root: string): AsyncIterableIterator<string> {
    const entries = await readdir(root, {withFileTypes: true});

    for (const entry of entries) {
        const full = path.join(root, entry.name);

        if (entry.isDirectory()) {
            if (isIgnoredDir(entry.name)) {
                continue;
            }

            yield* walkCanvas(full);
            continue;
        }

        if (entry.isFile() && entry.name.endsWith('.canvas')) {
            yield full;
        }
    }
}