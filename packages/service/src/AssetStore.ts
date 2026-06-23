import {writeAsset, type WriteAssetResult} from './Assets.js';

export interface AssetStoreWriteInput {
    noteId: string;
    content: Buffer;
    contentType: string | null;
}

/**
 * Storage port for binary assets (images today; arbitrary blobs once
 * other write paths land). Two implementations come into play:
 * - FilesystemAssetStore writes to <vaultPath>/<noteId>/_assets/ —
 *   matches the Obsidian-compatible layout the vault has always used
 *   and dedupes by sha1 content hash.
 * - NoopAssetStore rejects with a clear error so Server-Mode boot can
 *   wire it explicitly: assets need their own storage layer (S3,
 *   MariaDB BLOB column, …) — until that lands, refusing is more
 *   honest than silently writing into a dummy vault path nobody reads.
 */
export interface AssetStore {
    writeAsset(input: AssetStoreWriteInput): Promise<WriteAssetResult>;
}

/** Default impl — writes binary blobs into the vault folder tree. */
export class FilesystemAssetStore implements AssetStore {
    public constructor(private readonly vaultPath: string) {}

    public writeAsset(input: AssetStoreWriteInput): Promise<WriteAssetResult> {
        return writeAsset({
            vaultPath: this.vaultPath,
            noteId: input.noteId,
            content: input.content,
            contentType: input.contentType
        });
    }
}

/**
 * Server-Mode placeholder. Rejects writes with a clear, actionable
 * error so the user knows the feature is intentionally absent rather
 * than silently broken. A real implementation (BLOB column, S3,
 * Minio) replaces this when the asset path becomes server-mode
 * relevant.
 */
export class NoopAssetStore implements AssetStore {
    public writeAsset(): Promise<WriteAssetResult> {
        return Promise.reject(new Error(
            'Asset writes are not supported in server-mode yet — '
            + 'no blob storage backend is configured. '
            + 'See ADR Memory/synaipse/decisions/2026-06-23-server-mode-architecture.md.'
        ));
    }
}