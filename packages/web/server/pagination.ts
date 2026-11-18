import {badRequest} from './router.js';

/**
 * Opaque cursors for paginated list endpoints (plan P4 / A5). The value
 * is base64url-encoded JSON so clients treat it as a token and the server
 * can change what it carries. A cursor that does not decode or fails the
 * guard answers 400 instead of silently restarting at page one.
 */
export const encodeCursor = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

export const decodeCursor = <T>(raw: string | null, guard: (value: unknown) => value is T): T | null => {
    if (raw === null || raw.length === 0) return null;

    let value: unknown;
    try {
        value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
        throw badRequest('invalid cursor');
    }

    if (!guard(value)) {
        throw badRequest('invalid cursor');
    }

    return value;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Keyset page over items sorted ascending by a unique string key: the
 * items after `afterKey`, at most `limit`, plus the key to continue from.
 * Binary search, so deep pages cost the same as the first.
 */
export const keysetPage = <T>(
    sorted: readonly T[],
    key: (item: T) => string,
    afterKey: string | null,
    limit: number
): {items: T[]; nextKey: string | null} => {
    let lo = 0;

    if (afterKey !== null) {
        let hi = sorted.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (key(sorted[mid] as T) <= afterKey) lo = mid + 1;
            else hi = mid;
        }
    }

    const items = sorted.slice(lo, lo + limit);
    const last = items[items.length - 1];
    const more = lo + limit < sorted.length;

    return {items, nextKey: more && last !== undefined ? key(last) : null};
};
