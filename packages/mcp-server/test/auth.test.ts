import {describe, expect, it} from 'vitest';
import type {Config} from '@synaipse/core';
import {checkScope, isAuthConfigured, parseBearer, resolveTokenScope, NO_AUTH_SCOPE} from '../src/Auth.js';

const baseConfig = (overrides: Partial<Config['server']> = {}): Config => ({
    vaultPath: '/tmp/x',
    indexCachePath: '/tmp/idx.json',
    chatStoreDir: '/tmp/chats',
    auditLogPath: '/tmp/audit.jsonl',
    embeddings: {provider: 'none'},
    qdrant: {url: 'http://localhost:6333', collection: 'test'},
    server: {
        name: 'synaipse-test',
        version: '0.0.0',
        ...overrides
    },
    web: {port: 0}
});

describe('parseBearer', () => {
    it('returns null on missing header', () => {
        expect(parseBearer(undefined)).toBeNull();
    });

    it('returns null when prefix is not Bearer', () => {
        expect(parseBearer('Basic abc')).toBeNull();
    });

    it('strips the Bearer prefix and trims whitespace', () => {
        expect(parseBearer('Bearer  abc-123  ')).toBe('abc-123');
    });

    it('returns null on empty token after Bearer', () => {
        expect(parseBearer('Bearer    ')).toBeNull();
    });
});

describe('isAuthConfigured', () => {
    it('true when legacy single token is set', () => {
        expect(isAuthConfigured(baseConfig({token: 's3kr3t'}))).toBe(true);
    });

    it('true when granular tokens list has entries', () => {
        expect(isAuthConfigured(baseConfig({tokens: [{token: 't1'}]}))).toBe(true);
    });

    it('false when neither is set', () => {
        expect(isAuthConfigured(baseConfig())).toBe(false);
    });

    it('false when granular tokens list is empty', () => {
        expect(isAuthConfigured(baseConfig({tokens: []}))).toBe(false);
    });
});

describe('resolveTokenScope', () => {
    it('returns admin scope for the legacy single-token match', () => {
        const cfg = baseConfig({token: 's3kr3t'});
        const scope = resolveTokenScope('Bearer s3kr3t', cfg);
        expect(scope).not.toBeNull();
        expect(scope?.read).toBe(true);
        expect(scope?.write).toBe(true);
        expect(scope?.pathPrefixes).toEqual([]);
        expect(scope?.tools).toEqual([]);
    });

    it('returns null on legacy single-token mismatch', () => {
        const cfg = baseConfig({token: 's3kr3t'});
        expect(resolveTokenScope('Bearer wrong', cfg)).toBeNull();
    });

    it('matches granular tokens and forwards their scope', () => {
        const cfg = baseConfig({
            tokens: [{
                token: 'reader-only',
                label: 'reader',
                read: true,
                pathPrefixes: ['Memory/']
            }]
        });
        const scope = resolveTokenScope('Bearer reader-only', cfg);
        expect(scope).not.toBeNull();
        expect(scope?.label).toBe('reader');
        expect(scope?.read).toBe(true);
        expect(scope?.write).toBe(false);
        expect(scope?.pathPrefixes).toEqual(['Memory/']);
    });

    it('synthesises a token-hint label when none was given', () => {
        const cfg = baseConfig({tokens: [{token: 'longer-than-eight', read: true}]});
        const scope = resolveTokenScope('Bearer longer-than-eight', cfg);
        expect(scope?.label).toContain('ight');
    });

    it('falls through granular list to legacy token if no granular match', () => {
        const cfg = baseConfig({
            token: 'admin-fallback',
            tokens: [{token: 't1', read: true}]
        });
        const scope = resolveTokenScope('Bearer admin-fallback', cfg);
        expect(scope).not.toBeNull();
        expect(scope?.label).toBe('admin (single-token mode)');
        expect(scope?.write).toBe(true);
    });

    it('returns null when no Authorization header was sent at all', () => {
        const cfg = baseConfig({token: 's3kr3t'});
        expect(resolveTokenScope(undefined, cfg)).toBeNull();
    });

    it('timing-safe across mismatched lengths (no crash)', () => {
        const cfg = baseConfig({token: 'long-secret'});
        expect(resolveTokenScope('Bearer x', cfg)).toBeNull();
    });
});

describe('checkScope', () => {
    const grantAll = NO_AUTH_SCOPE;
    const readOnly = {
        label: 'reader',
        read: true,
        write: false,
        pathPrefixes: [] as readonly string[],
        tools: [] as readonly string[]
    };
    const writeOnly = {
        label: 'writer',
        read: false,
        write: true,
        pathPrefixes: [] as readonly string[],
        tools: [] as readonly string[]
    };
    const pathScoped = {
        label: 'memory-only',
        read: true,
        write: true,
        pathPrefixes: ['Memory/'] as readonly string[],
        tools: [] as readonly string[]
    };
    const toolScoped = {
        label: 'search-only',
        read: true,
        write: true,
        pathPrefixes: [] as readonly string[],
        tools: ['synaipse_search', 'synaipse_read_note'] as readonly string[]
    };

    it('allows everything under NO_AUTH_SCOPE', () => {
        expect(checkScope(grantAll, {name: 'synaipse_write_note', mode: 'write'}, 'foo.md')).toBeNull();
    });

    it('blocks write on read-only token', () => {
        expect(checkScope(readOnly, {name: 'synaipse_write_note', mode: 'write'}, 'foo.md')).toMatch(/lacks write/);
    });

    it('blocks read on write-only token', () => {
        expect(checkScope(writeOnly, {name: 'synaipse_read_note', mode: 'read'}, 'foo.md')).toMatch(/lacks read/);
    });

    it('allows path inside the scope', () => {
        expect(checkScope(pathScoped, {name: 'synaipse_write_note', mode: 'write'}, 'Memory/x.md')).toBeNull();
    });

    it('blocks path outside the scope', () => {
        const denial = checkScope(pathScoped, {name: 'synaipse_write_note', mode: 'write'}, 'Crawler/x.md');
        expect(denial).toMatch(/not allowed to touch path/);
    });

    it('skips path-prefix check when tool has no path arg', () => {
        expect(checkScope(pathScoped, {name: 'synaipse_search', mode: 'read'}, undefined)).toBeNull();
    });

    it('blocks tools outside the whitelist', () => {
        const denial = checkScope(toolScoped, {name: 'synaipse_write_note', mode: 'write'}, 'Memory/x.md');
        expect(denial).toMatch(/not allowed to call tool/);
    });

    it('allows tools inside the whitelist', () => {
        expect(checkScope(toolScoped, {name: 'synaipse_search', mode: 'read'}, undefined)).toBeNull();
        expect(checkScope(toolScoped, {name: 'synaipse_read_note', mode: 'read'}, 'foo.md')).toBeNull();
    });
});