import {describe, it, expect} from 'vitest';
import {isRetryableNetworkError} from '../src/Qdrant.js';

const errWithCode = (code: string, name = 'Error'): Error => {
    const e = new Error('boom') as Error & {code?: string};
    e.code = code;
    e.name = name;
    return e;
};

describe('isRetryableNetworkError', () => {
    it('flags SocketError by name', () => {
        const e = new Error('other side closed');
        e.name = 'SocketError';
        expect(isRetryableNetworkError(e)).toBe(true);
    });

    it('flags EPIPE', () => {
        expect(isRetryableNetworkError(errWithCode('EPIPE'))).toBe(true);
    });

    it('flags ECONNRESET / ECONNREFUSED / ETIMEDOUT', () => {
        expect(isRetryableNetworkError(errWithCode('ECONNRESET'))).toBe(true);
        expect(isRetryableNetworkError(errWithCode('ECONNREFUSED'))).toBe(true);
        expect(isRetryableNetworkError(errWithCode('ETIMEDOUT'))).toBe(true);
    });

    it('flags undici UND_ERR_* family', () => {
        expect(isRetryableNetworkError(errWithCode('UND_ERR_SOCKET'))).toBe(true);
        expect(isRetryableNetworkError(errWithCode('UND_ERR_CONNECT_TIMEOUT'))).toBe(true);
    });

    it('walks the cause chain (undici hides the real reason there)', () => {
        const inner = errWithCode('EPIPE');
        const outer = new TypeError('fetch failed') as TypeError & {cause?: unknown};
        outer.cause = inner;
        expect(isRetryableNetworkError(outer)).toBe(true);
    });

    it('returns false for plain Error without network code', () => {
        expect(isRetryableNetworkError(new Error('Chunk/vector count mismatch'))).toBe(false);
    });

    it('returns false for non-Error values', () => {
        expect(isRetryableNetworkError('boom')).toBe(false);
        expect(isRetryableNetworkError(undefined)).toBe(false);
        expect(isRetryableNetworkError(null)).toBe(false);
        expect(isRetryableNetworkError({message: 'shaped like an error'})).toBe(false);
    });

    it('does not loop on circular cause chains', () => {
        const a = new Error('a') as Error & {cause?: unknown};
        const b = new Error('b') as Error & {cause?: unknown};
        a.cause = b;
        b.cause = a;
        expect(isRetryableNetworkError(a)).toBe(false);
    });
});