import type {IncomingMessage, ServerResponse} from 'node:http';
import {createLogger} from '@synaipse/core';
import {BodyTooLargeError, InvalidBodyError} from './body.js';

const log = createLogger('web-api');

/**
 * Small route table for the HTTP API (plan P4 / A5). Replaces the
 * 1400-line if-chain in `routes.ts`:
 *
 * - Patterns are path strings. `:name` matches one segment, `:name+`
 *   matches the rest including slashes (note ids like `Memory/p/x.md`).
 *   Parameters arrive URI-decoded.
 * - A path that matches some route but not the method answers 405, an
 *   unknown path falls through (the caller decides on 404).
 * - Errors are mapped in one place: {@link HttpError} → its status,
 *   oversized body → 413, malformed body → 400, anything else → 500.
 */
export type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface RouteContext {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    params: Readonly<Record<string, string>>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

/** Throw from a handler to answer `{error: message}` with `status`. */
export class HttpError extends Error {
    public constructor(public readonly status: number, message: string) {
        super(message);
        this.name = 'HttpError';
    }
}

export const badRequest = (message: string): HttpError => new HttpError(400, message);

export const notFoundError = (message = 'not found'): HttpError => new HttpError(404, message);

export const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(body));
};

interface CompiledRoute {
    methods: ReadonlySet<string>;
    regex: RegExp;
    keys: readonly string[];
    handler: RouteHandler;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const compile = (pattern: string): {regex: RegExp; keys: string[]} => {
    const keys: string[] = [];
    const source = pattern.split('/').map((segment) => {
        const param = /^:([A-Za-z_]\w*)(\+)?$/.exec(segment);

        if (param === null) {
            return escapeRegex(segment);
        }

        keys.push(param[1] as string);
        return param[2] === '+' ? '(.+)' : '([^/]+)';
    }).join('/');

    return {regex: new RegExp(`^${source}$`), keys};
};

const decode = (raw: string): string => {
    try {
        return decodeURIComponent(raw);
    } catch {
        throw badRequest('malformed percent-encoding in path');
    }
};

export class Router {
    private readonly table: CompiledRoute[] = [];

    public on(methods: Method | readonly Method[], pattern: string, handler: RouteHandler): this {
        const list = typeof methods === 'string' ? [methods] : methods;
        this.table.push({methods: new Set(list), ...compile(pattern), handler});
        return this;
    }

    public get(pattern: string, handler: RouteHandler): this {
        return this.on('GET', pattern, handler);
    }

    public post(pattern: string, handler: RouteHandler): this {
        return this.on('POST', pattern, handler);
    }

    public put(pattern: string, handler: RouteHandler): this {
        return this.on('PUT', pattern, handler);
    }

    public delete(pattern: string, handler: RouteHandler): this {
        return this.on('DELETE', pattern, handler);
    }

    /**
     * Dispatch a request. Returns false when no route knows the path, so
     * the caller can try something else or answer 404. Handler errors are
     * NOT caught here; wrap the whole API in {@link withErrorMapping}.
     */
    public async dispatch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
        const method = req.method ?? 'GET';
        let pathMatched = false;

        for (const route of this.table) {
            const match = route.regex.exec(url.pathname);

            if (match === null) continue;
            pathMatched = true;
            if (!route.methods.has(method)) continue;

            const params: Record<string, string> = {};
            route.keys.forEach((key, i) => {
                params[key] = decode(match[i + 1] as string);
            });

            await route.handler({req, res, url, params});
            return true;
        }

        if (pathMatched) {
            json(res, 405, {error: 'method not allowed'});
            return true;
        }

        return false;
    }
}

/** Status for an error thrown by a handler. */
export const statusOf = (error: unknown): number => {
    if (error instanceof HttpError) return error.status;
    if (error instanceof BodyTooLargeError) return 413;
    if (error instanceof InvalidBodyError) return 400;
    return 500;
};

/**
 * Central error mapping for the API. Handlers throw, this answers. A
 * response that already started (SSE streams) is only closed.
 */
export const withErrorMapping = (
    handler: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>
) => async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    try {
        await handler(req, res, url);
    } catch (error) {
        const status = statusOf(error);
        const message = error instanceof Error ? error.message : String(error);

        if (status >= 500) {
            log.error('request failed', {method: req.method, path: url.pathname, error: message});
        }

        if (res.headersSent) {
            res.end();
            return;
        }

        json(res, status, {error: message});
    }
};

/** Required, non-empty query parameter or 400. */
export const requiredParam = (url: URL, name: string): string => {
    const value = url.searchParams.get(name);

    if (value === null || value.length === 0) {
        throw badRequest(`${name} query param required`);
    }

    return value;
};
