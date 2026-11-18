import type {IncomingMessage} from 'node:http';

/**
 * Request body reading for every route (plan P3 / E2).
 *
 * An embedding host may have consumed the stream already — e.g. PKG
 * Studio with `express.json()` mounted before Synaipse. Reading the
 * stream again would hang forever, so a body the host already parsed
 * (`req.body`, body-parser's `req._body` marker or an ended stream) is
 * used as-is. That removes the "mount Synaipse before express.json()"
 * ordering rule from the host.
 */
export class BodyTooLargeError extends Error {
    public constructor(public readonly limit: number) {
        super(`request body exceeds ${limit} bytes`);
        this.name = 'BodyTooLargeError';
    }
}

type MaybeParsed = IncomingMessage & {body?: unknown; _body?: boolean};

const preParsed = (req: MaybeParsed): Buffer | null => {
    if (req.body === undefined) return null;
    if (req._body !== true && !req.readableEnded) return null;
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
    return Buffer.from(JSON.stringify(req.body), 'utf8');
};

export const readRawBody = async (req: IncomingMessage, maxBytes = Number.POSITIVE_INFINITY): Promise<Buffer> => {
    const parsed = preParsed(req as MaybeParsed);
    if (parsed !== null) {
        if (parsed.length > maxBytes) throw new BodyTooLargeError(maxBytes);
        return parsed;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk as Buffer;
        total += buf.length;
        if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
        chunks.push(buf);
    }
    return Buffer.concat(chunks, total);
};

/** Parse a JSON body. An empty body throws `empty body`, unless `emptyAs` is given. */
export const readJsonBody = async <T>(req: IncomingMessage, opts: {emptyAs?: T} = {}): Promise<T> => {
    const raw = (await readRawBody(req)).toString('utf8');
    if (raw.length === 0) {
        if ('emptyAs' in opts) return opts.emptyAs as T;
        throw new Error('empty body');
    }
    return JSON.parse(raw) as T;
};
