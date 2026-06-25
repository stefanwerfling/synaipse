import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import type {Config} from '@synaipse/core';
import {SynaipseService} from '@synaipse/service';
import {buildMcpHttpHandler} from '../src/Server.js';
import {CachedUserStore} from '../src/CachedUserStore.js';
import {InMemoryUserStore} from './InMemoryUserStore.js';

const buildConfig = (vaultPath: string, indexCachePath: string): Config => ({
    vaultPath,
    indexCachePath,
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    auditLogPath: path.join(vaultPath, '.audit.jsonl'),
    embeddings: {provider: 'none'},
    qdrant: {url: 'http://localhost:6333', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0},
    project: {name: 'proj'}
});

interface FakeRes {
    statusCode: number;
    headers: Record<string, string>;
    ended: string;
    headersSent: boolean;
    setHeader: (name: string, value: string) => void;
    end: (body?: string) => void;
    on: (event: string, cb: () => void) => void;
}

const mockReq = (url: string, method = 'POST', headers: Record<string, string> = {}) => {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {url, method, headers}) as never;
};

const mockRes = (): FakeRes => {
    const res: FakeRes = {
        statusCode: 200,
        headers: {},
        ended: '',
        headersSent: false,
        setHeader: (name, value) => {
            res.headers[name.toLowerCase()] = value;
        },
        end: (body) => {
            res.ended = body ?? '';
            res.headersSent = true;
        },
        on: () => {}
    };
    return res;
};

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('POST /mcp/admin/flush-auth-cache', () => {
    let vaultDir: string;
    let service: SynaipseService;

    beforeEach(async () => {
        vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-mcp-admin-'));
    });

    afterEach(async () => {
        if (service !== undefined) await service.stop();
        await rm(vaultDir, {recursive: true, force: true});
    });

    it('returns 404 when no CachedUserStore is wired in (mode=local)', async () => {
        const config = buildConfig(vaultDir, path.join(vaultDir, '.cache.json'));
        config.server.token = 'admin-token';
        service = new SynaipseService(config);
        await service.start();

        const handler = buildMcpHttpHandler(config, service, {
            basePath: '/mcp',
            eventsUrl: null
        });

        const req = mockReq('/mcp/admin/flush-auth-cache', 'POST', {authorization: 'Bearer admin-token'});
        const res = mockRes();
        handler(req, res as never);
        await flush();

        expect(res.statusCode).toBe(404);
        expect(res.ended).toBe('auth cache not active');
    });

    it('returns 401 when no auth header is sent', async () => {
        const inner = new InMemoryUserStore();
        await inner.createUser({label: 'admin', read: true, write: true});
        const cached = new CachedUserStore(inner);

        const config = buildConfig(vaultDir, path.join(vaultDir, '.cache.json'));
        service = new SynaipseService(config);
        await service.start();

        const handler = buildMcpHttpHandler(config, service, {
            basePath: '/mcp',
            eventsUrl: null,
            userStore: cached
        });

        const req = mockReq('/mcp/admin/flush-auth-cache', 'POST');
        const res = mockRes();
        handler(req, res as never);
        await flush();

        expect(res.statusCode).toBe(401);
    });

    it('returns 403 for a read-only token', async () => {
        const inner = new InMemoryUserStore();
        const {plainToken} = await inner.createUser({label: 'reader', read: true, write: false});
        const cached = new CachedUserStore(inner);

        const config = buildConfig(vaultDir, path.join(vaultDir, '.cache.json'));
        service = new SynaipseService(config);
        await service.start();

        const handler = buildMcpHttpHandler(config, service, {
            basePath: '/mcp',
            eventsUrl: null,
            userStore: cached
        });

        const req = mockReq('/mcp/admin/flush-auth-cache', 'POST', {authorization: `Bearer ${plainToken}`});
        const res = mockRes();
        handler(req, res as never);
        await flush();

        expect(res.statusCode).toBe(403);
        expect(res.ended).toMatch(/admin scope required/);
    });

    it('returns 403 for a path-scoped write token (not unrestricted admin)', async () => {
        const inner = new InMemoryUserStore();
        const {plainToken} = await inner.createUser({
            label: 'narrow-writer',
            read: true,
            write: true,
            pathPrefixes: ['Memory/']
        });
        const cached = new CachedUserStore(inner);

        const config = buildConfig(vaultDir, path.join(vaultDir, '.cache.json'));
        service = new SynaipseService(config);
        await service.start();

        const handler = buildMcpHttpHandler(config, service, {
            basePath: '/mcp',
            eventsUrl: null,
            userStore: cached
        });

        const req = mockReq('/mcp/admin/flush-auth-cache', 'POST', {authorization: `Bearer ${plainToken}`});
        const res = mockRes();
        handler(req, res as never);
        await flush();

        expect(res.statusCode).toBe(403);
    });

    it('flushes the cache and returns 200 + count for an admin token', async () => {
        const inner = new InMemoryUserStore();
        const {plainToken: adminToken} = await inner.createUser({label: 'admin', read: true, write: true});
        const {plainToken: otherToken} = await inner.createUser({label: 'other', read: true, write: false});
        const cached = new CachedUserStore(inner);

        // prime cache via direct lookup so we have entries to flush
        await cached.findByToken(adminToken);
        await cached.findByToken(otherToken);
        expect(cached.size()).toBe(2);

        const config = buildConfig(vaultDir, path.join(vaultDir, '.cache.json'));
        service = new SynaipseService(config);
        await service.start();

        const handler = buildMcpHttpHandler(config, service, {
            basePath: '/mcp',
            eventsUrl: null,
            userStore: cached
        });

        const req = mockReq('/mcp/admin/flush-auth-cache', 'POST', {authorization: `Bearer ${adminToken}`});
        const res = mockRes();
        handler(req, res as never);
        await flush();

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('application/json');

        // After successful auth on adminToken, the cache held the now-flushed
        // entries plus the admin lookup primed by the request itself (count
        // is observed BEFORE the flush). The post-flush state is empty.
        const payload = JSON.parse(res.ended);
        expect(payload.flushed).toBeGreaterThanOrEqual(2);
        expect(cached.size()).toBe(0);
    });

    it('returns 405 for non-POST methods', async () => {
        const inner = new InMemoryUserStore();
        const {plainToken} = await inner.createUser({label: 'admin', read: true, write: true});
        const cached = new CachedUserStore(inner);

        const config = buildConfig(vaultDir, path.join(vaultDir, '.cache.json'));
        service = new SynaipseService(config);
        await service.start();

        const handler = buildMcpHttpHandler(config, service, {
            basePath: '/mcp',
            eventsUrl: null,
            userStore: cached
        });

        const req = mockReq('/mcp/admin/flush-auth-cache', 'GET', {authorization: `Bearer ${plainToken}`});
        const res = mockRes();
        handler(req, res as never);
        await flush();

        expect(res.statusCode).toBe(405);
        expect(res.headers['allow']).toBe('POST');
    });
});