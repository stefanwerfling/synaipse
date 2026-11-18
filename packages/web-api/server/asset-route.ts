import path from 'node:path';

/**
 * MIME type used to serve a given asset extension. The allowed-list
 * also doubles as the gate for what `/api/asset?path=...` will serve —
 * anything with an unknown extension yields 415, even if the byte
 * content is harmless. This keeps the route from being abused to
 * exfiltrate arbitrary vault files (e.g. .md notes via the same path,
 * even though that's already covered by the `_assets/`-segment check).
 */
const ASSET_MIME: Readonly<Record<string, string>> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml'
};

export interface ResolvedAsset {
    /** Absolute filesystem path the route should stream. */
    absolutePath: string;
    /** Content-Type header value. */
    contentType: string;
}

export type ResolveAssetError =
    | {kind: 'missing-path'}
    | {kind: 'illegal-path'; reason: string}
    | {kind: 'unsupported-extension'; ext: string};

export type ResolveAssetResult =
    | {ok: true; value: ResolvedAsset}
    | {ok: false; error: ResolveAssetError};

/**
 * Resolve a `?path=...` query into a safe absolute filesystem path
 * inside the vault. The path must:
 *   1. be non-empty
 *   2. resolve under `vaultRoot` (no parent-directory escape)
 *   3. live in an `_assets/` directory segment (route is asset-only —
 *      regular notes go through /api/notes)
 *   4. have an allow-listed image extension
 *
 * Returns either a `ResolvedAsset` with absolute path + MIME or a
 * tagged error so the caller can map each case to the right HTTP
 * status (400 vs 403 vs 415 vs 404 from the stat that comes after).
 */
export const resolveAssetPath = (vaultRoot: string, requested: string | null): ResolveAssetResult => {
    if (requested === null || requested.length === 0) {
        return {ok: false, error: {kind: 'missing-path'}};
    }

    if (requested.includes('\0')) {
        return {ok: false, error: {kind: 'illegal-path', reason: 'null byte in path'}};
    }

    // Reject anything that looks absolute or contains an explicit
    // protocol-like prefix; the route accepts vault-relative paths only.
    if (path.isAbsolute(requested) || requested.startsWith('//')) {
        return {ok: false, error: {kind: 'illegal-path', reason: 'absolute paths not allowed'}};
    }

    const normalized = path.posix.normalize(requested);

    if (normalized.startsWith('..') || normalized.includes('/../')) {
        return {ok: false, error: {kind: 'illegal-path', reason: 'parent directory escape'}};
    }

    // Path-traversal hardening: resolve against vaultRoot and assert the
    // result is still prefixed by vaultRoot + separator. `path.resolve`
    // handles `..` segments that may have slipped past the string check
    // above (cross-platform separator differences, etc.).
    const absolute = path.resolve(vaultRoot, normalized);
    if (!absolute.startsWith(vaultRoot + path.sep) && absolute !== vaultRoot) {
        return {ok: false, error: {kind: 'illegal-path', reason: 'resolves outside vault'}};
    }

    // The route is asset-only. Notes / config / arbitrary vault files
    // are intentionally NOT served — they have dedicated endpoints.
    const segments = normalized.split('/');
    if (!segments.includes('_assets')) {
        return {ok: false, error: {kind: 'illegal-path', reason: 'must point inside an _assets/ folder'}};
    }

    const ext = path.extname(normalized).toLowerCase();
    const mime = ASSET_MIME[ext];
    if (mime === undefined) {
        return {ok: false, error: {kind: 'unsupported-extension', ext}};
    }

    return {ok: true, value: {absolutePath: absolute, contentType: mime}};
};