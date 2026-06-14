import {createHash} from 'node:crypto';
import {access, mkdir, writeFile} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import path from 'node:path';

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const EXT_BY_MIME: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/svg+xml': 'svg'
};

export const hashUrl = (url: string): string => {
    return createHash('sha1').update(url).digest('hex').slice(0, 12);
};

const extFromUrl = (url: string): string | undefined => {
    const pathPart = url.split('?')[0] ?? '';
    const match = pathPart.match(/\.([A-Za-z0-9]{2,5})$/);
    return match?.[1]?.toLowerCase();
};

const extFromMime = (contentType: string | null): string | undefined => {
    if (contentType === null) return undefined;
    const head = contentType.split(';')[0]?.trim().toLowerCase();
    return head !== undefined ? EXT_BY_MIME[head] : undefined;
};

export const assetFilename = (url: string, contentType: string | null): string => {
    const ext = extFromUrl(url) ?? extFromMime(contentType) ?? 'bin';
    return `img-${hashUrl(url)}.${ext}`;
};

const fileExists = async (target: string): Promise<boolean> => {
    try {
        await access(target, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
};

export interface DownloadResult {
    ok: boolean;
    filename: string;
    cached: boolean;
    size: number;
    error?: string;
}

export const downloadAsset = async (
    url: string,
    targetDir: string,
    fetchImpl: typeof fetch = fetch
): Promise<DownloadResult> => {
    if (!/^https?:\/\//i.test(url)) {
        return {ok: false, filename: '', cached: false, size: 0, error: 'not an http(s) url'};
    }

    try {
        // probe extension from URL first — avoids one HEAD call on the happy path
        let filename = assetFilename(url, null);
        let target = path.join(targetDir, filename);

        if (await fileExists(target)) {
            return {ok: true, filename, cached: true, size: 0};
        }

        const response = await fetchImpl(url);

        if (!response.ok) {
            return {ok: false, filename: '', cached: false, size: 0, error: `${response.status}`};
        }

        const contentType = response.headers.get('content-type');
        // re-derive filename with mime info in case URL had no extension
        filename = assetFilename(url, contentType);
        target = path.join(targetDir, filename);

        if (await fileExists(target)) {
            return {ok: true, filename, cached: true, size: 0};
        }

        const buf = Buffer.from(await response.arrayBuffer());
        await mkdir(targetDir, {recursive: true});
        await writeFile(target, buf);

        return {ok: true, filename, cached: false, size: buf.length};
    } catch (cause) {
        return {ok: false, filename: '', cached: false, size: 0, error: String(cause)};
    }
};

export const extractImageUrls = (markdown: string): string[] => {
    const urls = new Set<string>();

    for (const match of markdown.matchAll(IMAGE_RE)) {
        const url = match[2];

        if (url !== undefined && /^https?:\/\//i.test(url)) {
            urls.add(url);
        }
    }

    return [...urls];
};

export const rewriteImageUrls = (
    markdown: string,
    mapping: ReadonlyMap<string, string>
): string => {
    return markdown.replaceAll(IMAGE_RE, (whole, alt: string, url: string) => {
        const local = mapping.get(url);
        return local !== undefined ? `![${alt}](./${local})` : whole;
    });
};