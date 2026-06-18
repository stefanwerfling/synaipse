import {readdir} from 'node:fs/promises';
import path from 'node:path';

const IGNORED_DIRS = new Set(['.git', '.obsidian', 'node_modules', '.trash', '.synaipse-chats']);

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