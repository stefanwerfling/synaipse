import {readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';

/**
 * Repo walker for the code crawler. POSIX-relative paths, gitignore-aware,
 * extension-filtered. We deliberately read .gitignore at the repo root only
 * — nested gitignores are rare for the directories that matter (node_modules,
 * dist, build) and a recursive walk that hits every gitignore is overkill
 * for the MVP.
 */

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

const DEFAULT_SKIP_DIRS = new Set([
    'node_modules',
    'dist',
    'build',
    'out',
    'target',
    '.git',
    '.next',
    '.nuxt',
    '.cache',
    '.turbo',
    '.svelte-kit',
    '.parcel-cache',
    'coverage',
    '__pycache__',
    '.venv',
    'venv',
    '.idea',
    '.vscode'
]);

export interface WalkResult {
    /** Repo-relative POSIX paths of source files we want to ingest. */
    files: string[];
    /** Number of entries we skipped via the skip list / gitignore / extension filter. */
    skipped: number;
}

const readGitignoreGlobs = async (repoRoot: string): Promise<string[]> => {
    try {
        const raw = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
        return raw
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith('#'));
    } catch {
        return [];
    }
};

const isGitignoreMatch = (relPath: string, globs: readonly string[]): boolean => {
    for (const raw of globs) {
        // Strip leading slash (anchored) — we already work in repo-relative paths.
        const pattern = raw.replace(/^\/+/, '').replace(/\/$/, '');
        if (pattern.length === 0) continue;

        // Very simple matcher — supports literal directory matches and one
        // trailing `*`. Avoids pulling in a full glob library for what's
        // mostly node_modules / dist / .env shape.
        if (pattern.includes('*')) {
            const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
            const segments = relPath.split('/');
            if (segments.some((seg) => re.test(seg))) return true;
            if (re.test(relPath)) return true;
            continue;
        }

        const segments = relPath.split('/');
        if (segments.includes(pattern)) return true;
        if (relPath === pattern || relPath.startsWith(`${pattern}/`)) return true;
    }

    return false;
};

export const walkRepo = async (
    repoRoot: string,
    extraExcludes: readonly string[] = []
): Promise<WalkResult> => {
    const rootStat = await stat(repoRoot);
    if (!rootStat.isDirectory()) {
        throw new Error(`not a directory: ${repoRoot}`);
    }

    const gitignore = await readGitignoreGlobs(repoRoot);
    const extraGlobs = [...gitignore, ...extraExcludes];

    const files: string[] = [];
    let skipped = 0;

    const queue: string[] = [''];

    while (queue.length > 0) {
        const relDir = queue.shift() as string;
        const absDir = path.join(repoRoot, relDir);

        let entries;
        try {
            entries = await readdir(absDir, {withFileTypes: true});
        } catch {
            skipped += 1;
            continue;
        }

        for (const entry of entries) {
            const name = entry.name;
            const relPath = relDir === '' ? name : `${relDir}/${name}`;

            if (entry.isDirectory()) {
                if (DEFAULT_SKIP_DIRS.has(name)) {
                    skipped += 1;
                    continue;
                }

                if (isGitignoreMatch(relPath, extraGlobs)) {
                    skipped += 1;
                    continue;
                }

                queue.push(relPath);
                continue;
            }

            if (!entry.isFile()) {
                skipped += 1;
                continue;
            }

            const ext = path.extname(name);
            if (!SUPPORTED_EXTENSIONS.has(ext)) {
                skipped += 1;
                continue;
            }

            if (isGitignoreMatch(relPath, extraGlobs)) {
                skipped += 1;
                continue;
            }

            files.push(relPath);
        }
    }

    return {files: files.sort(), skipped};
};