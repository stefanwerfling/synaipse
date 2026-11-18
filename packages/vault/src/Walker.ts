import {readdir} from 'node:fs/promises';
import path from 'node:path';

// Keep in sync with Watcher.ts. `.synaipse/` holds the SQLite state DB,
// `.ngit/` the version history — neither contains notes.
const IGNORED_DIRS = new Set(['.git', '.ngit', '.synaipse', '.obsidian', 'node_modules', '.trash', '.synaipse-chats']);

export async function* walkMarkdown(root: string): AsyncIterableIterator<string> {
    const entries = await readdir(root, {withFileTypes: true});

    for (const entry of entries) {
        const full = path.join(root, entry.name);

        if (entry.isDirectory()) {
            if (IGNORED_DIRS.has(entry.name)) {
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
            if (IGNORED_DIRS.has(entry.name)) {
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