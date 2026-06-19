import {createHash} from 'node:crypto';
import {mkdir, writeFile, access} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import path from 'node:path';

export const MIME_TO_EXT: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/svg+xml': 'svg'
};

export const isAllowedAssetMime = (contentType: string | null): boolean => {
    if (contentType === null) return false;
    const head = contentType.split(';')[0]?.trim().toLowerCase();
    return head !== undefined && head in MIME_TO_EXT;
};

const extFromMime = (contentType: string | null): string => {
    if (contentType === null) return 'bin';
    const head = contentType.split(';')[0]?.trim().toLowerCase();
    return head !== undefined ? (MIME_TO_EXT[head] ?? 'bin') : 'bin';
};

const ASSET_FOLDER = '_assets';

/** Derive the project-scoped assets folder for a given note id. */
export const assetsFolderForNote = (noteId: string): string => {
    const parts = noteId.split('/');

    if (parts.length >= 2 && parts[0] === 'Memory') {
        return `Memory/${parts[1]}/${ASSET_FOLDER}`;
    }

    return ASSET_FOLDER;
};

/**
 * Compute the relative path from a note to an asset file. Both are
 * vault-relative ids. The result is the standard Markdown relative path
 * usable in ![](…).
 */
export const relativeAssetPath = (noteId: string, assetId: string): string => {
    const noteSegs = noteId.split('/').slice(0, -1);
    const assetSegs = assetId.split('/');

    let common = 0;
    while (
        common < noteSegs.length
        && common < assetSegs.length - 1
        && noteSegs[common] === assetSegs[common]
    ) {
        common += 1;
    }

    const ups = noteSegs.slice(common).map(() => '..');
    const down = assetSegs.slice(common);

    if (ups.length === 0) {
        return ['.', ...down].join('/');
    }

    return [...ups, ...down].join('/');
};

export interface WriteAssetInput {
    vaultPath: string;
    noteId: string;
    content: Buffer;
    contentType: string | null;
}

export interface WriteAssetResult {
    /** Vault-relative path of the asset (e.g. Memory/proj/_assets/img-…png). */
    assetId: string;
    /** Note-relative markdown path ready to drop into ![](…). */
    relativePath: string;
    /** Bytes actually written. 0 when we deduped against an existing file. */
    written: number;
    /** True when the same content already existed and was reused. */
    deduped: boolean;
}

const fileExists = async (target: string): Promise<boolean> => {
    try {
        await access(target, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
};

export const writeAsset = async (input: WriteAssetInput): Promise<WriteAssetResult> => {
    const sha = createHash('sha1').update(input.content).digest('hex').slice(0, 12);
    const ext = extFromMime(input.contentType);
    const filename = `img-${sha}.${ext}`;

    const folder = assetsFolderForNote(input.noteId);
    const assetId = `${folder}/${filename}`;
    const absolute = path.join(input.vaultPath, assetId);

    if (await fileExists(absolute)) {
        return {
            assetId,
            relativePath: relativeAssetPath(input.noteId, assetId),
            written: 0,
            deduped: true
        };
    }

    await mkdir(path.dirname(absolute), {recursive: true});
    await writeFile(absolute, input.content);

    return {
        assetId,
        relativePath: relativeAssetPath(input.noteId, assetId),
        written: input.content.length,
        deduped: false
    };
};