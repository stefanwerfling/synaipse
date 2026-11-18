import {createHash} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';

const gzipAsync = promisify(gzip);

/** Below this size gzip costs more than it saves. */
const GZIP_MIN_BYTES = 4096;

interface Encoded {
    etag: string;
    raw: Buffer;
    gz: Promise<Buffer> | null;
}

/**
 * Serialized + compressed bodies, keyed by the identity of the value.
 * The service hands out the SAME graph/layout object until the topology
 * changes, so each version is stringified and gzipped once instead of on
 * every request (plan P4 / A5). Entries die with their object.
 */
const encodedBodies = new WeakMap<object, Encoded>();

const acceptsGzip = (req: IncomingMessage): boolean => {
    const header = req.headers['accept-encoding'];
    if (typeof header !== 'string') return false;
    return header.split(',').some((token) => token.trim().toLowerCase().startsWith('gzip'));
};

/** Does If-None-Match name this ETag (or `*`)? Weak validators compare equal too. */
const notModified = (req: IncomingMessage, etag: string): boolean => {
    const header = req.headers['if-none-match'];
    if (typeof header !== 'string') return false;

    return header.split(',').some((token) => {
        const tag = token.trim().replace(/^W\//, '');
        return tag === '*' || tag === etag;
    });
};

const encode = (body: object, etagSeed: string | undefined): Encoded => {
    const cached = encodedBodies.get(body);

    if (cached !== undefined) {
        return cached;
    }

    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const seed = etagSeed ?? createHash('sha1').update(raw).digest('hex');
    const entry: Encoded = {etag: `"${seed}"`, raw, gz: null};

    encodedBodies.set(body, entry);
    return entry;
};

/**
 * JSON response for large, rarely changing read models (whole graph,
 * Atlas layout): ETag + 304 for revalidation, `Cache-Control: no-cache`
 * so clients always revalidate, and a gzip buffer computed once per body
 * object. `etagSeed` skips hashing when the value already carries a
 * content hash (the layout's `hash`).
 */
export const jsonCached = async (
    req: IncomingMessage,
    res: ServerResponse,
    body: object,
    etagSeed?: string
): Promise<void> => {
    const entry = encode(body, etagSeed);
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'ETag': entry.etag,
        'Cache-Control': 'no-cache',
        'Vary': 'Accept-Encoding'
    };

    if (notModified(req, entry.etag)) {
        res.writeHead(304, headers);
        res.end();
        return;
    }

    if (entry.raw.length < GZIP_MIN_BYTES || !acceptsGzip(req)) {
        res.writeHead(200, {...headers, 'Content-Length': String(entry.raw.length)});
        res.end(entry.raw);
        return;
    }

    entry.gz ??= gzipAsync(entry.raw);
    const compressed = await entry.gz;

    res.writeHead(200, {...headers, 'Content-Encoding': 'gzip', 'Content-Length': String(compressed.length)});
    res.end(compressed);
};

/**
 * Plain JSON with gzip when the client accepts it and the body is large
 * enough to benefit. For large responses that are built per request
 * (canvas, roadmap, note list), where {@link jsonCached}'s per-object
 * cache would never hit.
 */
export const jsonGzip = async (req: IncomingMessage, res: ServerResponse, status: number, body: unknown): Promise<void> => {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');

    if (raw.length < GZIP_MIN_BYTES || !acceptsGzip(req)) {
        res.writeHead(status, {'Content-Type': 'application/json', 'Content-Length': String(raw.length)});
        res.end(raw);
        return;
    }

    const compressed = await gzipAsync(raw);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': String(compressed.length),
        'Vary': 'Accept-Encoding'
    });
    res.end(compressed);
};

/**
 * Integer query parameter clamped to [min, max]; missing or non-numeric
 * values give `fallback` (no more NaN limits reaching the service).
 */
export const intParam = (url: URL, name: string, fallback: number, min: number, max: number): number => {
    const raw = url.searchParams.get(name);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    const value = Number.isFinite(parsed) ? parsed : fallback;

    return Math.min(max, Math.max(min, value));
};
