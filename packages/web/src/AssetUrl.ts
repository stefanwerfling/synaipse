/**
 * Rewrite a markdown-image `src` to a `/api/asset?path=...` URL when it
 * points at a vault-relative asset path. Returns `null` when the src
 * should pass through unchanged: absolute URLs (http://…, data:, /),
 * fragments, or sources that don't end in a recognized asset extension.
 *
 * `noteId` is the vault-relative id of the note whose markdown is being
 * rendered. We resolve `./_assets/img.png` against the note's directory
 * to land on the canonical vault-relative asset id, then encode it as
 * the `path` query param.
 */
const ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'
]);

const PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:/i;

export const resolveAssetUrl = (src: string, noteId: string | undefined): string | null => {
    if (src.length === 0) return null;

    // Absolute URL (http://, https://, data:, mailto:, …) — pass through.
    if (PROTOCOL_RE.test(src) || src.startsWith('//')) return null;

    // Protocol-relative `/` paths point at host root; we don't rewrite
    // those because they're typically already API or static-mount URLs
    // (e.g. a future `/api/asset/...` direct path would be matched here).
    if (src.startsWith('/')) return null;

    // Drop fragment & query before extension check / path joining; we
    // preserve them on the output URL.
    const hashIdx = src.indexOf('#');
    const queryIdx = src.indexOf('?');
    const splitAt = hashIdx === -1 ? queryIdx : (queryIdx === -1 ? hashIdx : Math.min(hashIdx, queryIdx));
    const corePath = splitAt === -1 ? src : src.slice(0, splitAt);
    const suffix = splitAt === -1 ? '' : src.slice(splitAt);

    const dotIdx = corePath.lastIndexOf('.');
    if (dotIdx === -1) return null;
    const ext = corePath.slice(dotIdx + 1).toLowerCase();
    if (!ASSET_EXTENSIONS.has(ext)) return null;

    // Resolve `./_assets/...` etc. against the note's directory using a
    // fake-base URL trick: the URL constructor handles `.` / `..` /
    // multiple slashes per WHATWG without us reimplementing the parser.
    let basePath: string;
    if (noteId !== undefined && noteId.length > 0) {
        const lastSlash = noteId.lastIndexOf('/');
        basePath = lastSlash === -1 ? '/' : '/' + noteId.slice(0, lastSlash) + '/';
    } else {
        basePath = '/';
    }

    let resolvedPath: string;
    try {
        const u = new URL(corePath, `https://vault.local${basePath}`);
        // Strip the leading '/' from the resolved pathname — vault ids
        // never start with a slash. Also decode the URL-percent-encoding
        // because the path query param is encoded again on the way out.
        resolvedPath = decodeURIComponent(u.pathname.replace(/^\//, ''));
    } catch {
        return null;
    }

    if (resolvedPath.length === 0) return null;

    return `/api/asset?path=${encodeURIComponent(resolvedPath)}${suffix}`;
};