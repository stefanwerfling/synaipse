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

/** Body is empty or not valid JSON; the API answers 400. */
export class InvalidBodyError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'InvalidBodyError';
    }
}

/** Default cap for JSON bodies (plan P4 / A5). Clipped pages are the largest legitimate ones. */
export const JSON_BODY_LIMIT = 8 * 1024 * 1024;

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

/**
 * Parse a JSON body of at most `maxBytes` (default {@link JSON_BODY_LIMIT}).
 * An empty body throws {@link InvalidBodyError}, unless `emptyAs` is given;
 * so does malformed JSON. Too large → {@link BodyTooLargeError}.
 */
export const readJsonBody = async <T>(
    req: IncomingMessage,
    opts: {emptyAs?: T; maxBytes?: number} = {}
): Promise<T> => {
    const raw = (await readRawBody(req, opts.maxBytes ?? JSON_BODY_LIMIT)).toString('utf8');
    if (raw.length === 0) {
        if ('emptyAs' in opts) return opts.emptyAs as T;
        throw new InvalidBodyError('empty body');
    }
    try {
        return JSON.parse(raw) as T;
    } catch {
        throw new InvalidBodyError('body is not valid JSON');
    }
};

/** Like {@link readJsonBody}, but the body must be a JSON object (not null, an array or a scalar). */
export const readJsonObject = async <T extends object>(req: IncomingMessage, opts: {maxBytes?: number} = {}): Promise<T> => {
    const value = await readJsonBody<unknown>(req, opts);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new InvalidBodyError('body must be a JSON object');
    }
    return value as T;
};

/** Minimal schema shape (VTS and anything alike): a type guard that collects errors. */
export interface BodySchema<T> {
    validate(value: unknown, errors: unknown[]): value is T;
}

/** Read a JSON body and check it against `schema`; a mismatch is a 400 naming the first problem. */
export const readValidated = async <T>(req: IncomingMessage, schema: BodySchema<T>, opts: {maxBytes?: number} = {}): Promise<T> => {
    const value = await readJsonBody<unknown>(req, opts);
    const errors: unknown[] = [];
    if (!schema.validate(value, errors)) {
        throw new InvalidBodyError(`body does not match the expected shape${describeFirst(errors)}`);
    }
    return value;
};

/** First problem of a VTS error tree (`string | {key: errors}`) as "path: message". */
export const describeFirst = (errors: readonly unknown[], path: string[] = []): string => {
    for (const entry of errors) {
        if (typeof entry === 'string') return path.length > 0 ? `: ${path.join('.')}: ${entry}` : `: ${entry}`;
        if (typeof entry === 'object' && entry !== null) {
            for (const [key, nested] of Object.entries(entry)) {
                if (Array.isArray(nested)) {
                    const found = describeFirst(nested, [...path, key]);
                    if (found !== '') return found;
                }
            }
        }
    }
    return '';
};
