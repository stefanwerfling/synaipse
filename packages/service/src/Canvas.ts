import {mkdir, readFile, stat, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseCanvas, serializeCanvas, type CanvasDocument} from '@synaipse/core';
import {walkCanvas} from '@synaipse/vault';

export interface CanvasSummary {
    id: string;
    mtime: number;
    size: number;
}

const relId = (root: string, absolute: string): string => {
    const rel = path.relative(root, absolute);
    return rel.split(path.sep).join('/');
};

const insideRoot = (root: string, target: string): boolean => {
    const rel = path.relative(root, target);
    return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Walk the vault for `.canvas` files. No caching — canvases are read
 * on tab entry and rarely change out-of-band, so a fresh readdir per
 * request keeps the code path simple. If a vault ever accumulates
 * enough `.canvas` files to feel it, we can add a HashCache-style
 * layer analogous to what the note index does.
 */
export const listCanvasesInVault = async (root: string): Promise<CanvasSummary[]> => {
    const results: CanvasSummary[] = [];

    for await (const abs of walkCanvas(root)) {
        const st = await stat(abs);
        results.push({
            id: relId(root, abs),
            mtime: st.mtimeMs,
            size: st.size
        });
    }

    results.sort((a, b) => a.id.localeCompare(b.id));
    return results;
};

/**
 * Read + parse a canvas file. `id` is vault-relative (as returned by
 * `listCanvasesInVault`). Path-traversal is rejected — anything that
 * resolves outside `root` throws so a hand-crafted `?path=../etc/passwd`
 * can't leak arbitrary files.
 */
export const readCanvasFromVault = async (root: string, id: string): Promise<CanvasDocument> => {
    if (!id.endsWith('.canvas')) {
        throw new Error(`not a canvas file: ${id}`);
    }

    const absolute = path.resolve(root, id);
    if (!insideRoot(root, absolute)) {
        throw new Error(`canvas path escapes vault root: ${id}`);
    }

    const raw = await readFile(absolute, 'utf8');
    return parseCanvas(raw);
};

/**
 * Serialize + write a canvas file. Creates parent directories as needed
 * so a fresh path like `Boards/foo/plan.canvas` doesn't fail on first
 * save. Path-traversal is rejected identically to the read path.
 */
export const writeCanvasToVault = async (root: string, id: string, doc: CanvasDocument): Promise<void> => {
    if (!id.endsWith('.canvas')) {
        throw new Error(`not a canvas file: ${id}`);
    }

    const absolute = path.resolve(root, id);
    if (!insideRoot(root, absolute)) {
        throw new Error(`canvas path escapes vault root: ${id}`);
    }

    await mkdir(path.dirname(absolute), {recursive: true});
    await writeFile(absolute, serializeCanvas(doc), 'utf8');
};

export const deleteCanvasFromVault = async (root: string, id: string): Promise<void> => {
    if (!id.endsWith('.canvas')) {
        throw new Error(`not a canvas file: ${id}`);
    }

    const absolute = path.resolve(root, id);
    if (!insideRoot(root, absolute)) {
        throw new Error(`canvas path escapes vault root: ${id}`);
    }

    await unlink(absolute);
};