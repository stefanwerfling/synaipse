import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import type {Config} from '@synaipse/core';
import {SynaipseService} from '@synaipse/service';
import {buildMcpHttpHandler} from '../src/Server.js';

const buildConfig = (vaultPath: string, indexCachePath: string, token?: string): Config => ({
    vaultPath,
    indexCachePath,
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    auditLogPath: path.join(vaultPath, '.audit.jsonl'),
    embeddings: {provider: 'none'},
    qdrant: {url: 'http://localhost:6333', collection: 'test'},
    server: {
        name: 'synaipse-test',
        version: '0.0.0',
        ...(token !== undefined ? {token} : {})
    },
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

const mockReq = (url: string, headers: Record<string, string> = {}) => {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {url, method: 'POST', headers}) as never;
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

describe('MCP HTTP bearer auth', () => {
    let vaultDir: string;
    let service: SynaipseService;

    beforeEach(async () => {
        vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-mcp-auth-'));
    });

    afterEach(async () => {
        if (service !== undefined) {
            await service.stop();
        }
        await rm(vaultDir, {recursive: true, force: true});
    });

    it('rejects requests without an Authorization header when a token is configured', async () => {
        const config = buildConfig(vaultDir, path.join(vaultDir, '.cache.json'), 'sekret-token');
        service = new SynaipseService(config);
        await service.start();

        const handler = buildMcpHttpHandler(config, service, {basePath: '/mcp', eventsUrl: null});
        const req = mockReq('/mcp');
        const res = mockRes();
        handler(req, res as never);

        expect(res.statusCode).toBe(401);
        expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
        expect(res.ended).toBe('unauthorised');
    });

    it('rejects requests with the wrong token', async () => {
        const config = buildConfig(vaultDir, path.join(vaultDir, '.cache.json'), 'sekret-token');
        service = new SynaipseService(config);
        await service.start();

        const handler = buildMcpHttpHandler(config, service, {basePath: '/mcp', eventsUrl: null});
        const req = mockReq('/mcp', {authorization: 'Bearer not-the-right-one'});
        const res = mockRes();
        handler(req, res as never);

        expect(res.statusCode).toBe(401);
    });

    it('lets requests through when the bearer matches the configured token', async () => {
        const config = buildConfig(vaultDir, path.join(vaultDir, '.cache.json'), 'sekret-token');
        service = new SynaipseService(config);
        await service.start();

        const handler = buildMcpHttpHandler(config, service, {basePath: '/mcp', eventsUrl: null});
        const req = mockReq('/mcp', {authorization: 'Bearer sekret-token'});
        const res = mockRes();
        handler(req, res as never);

        // Auth check happens synchronously; the actual MCP transport work is
        // fire-and-forget after auth passes. If checkAuth had rejected, the
        // status would already be 401 on this line.
        expect(res.statusCode).not.toBe(401);
    });

    it('lets requests through with no Authorization header when token is unset', async () => {
        const config = buildConfig(vaultDir, path.join(vaultDir, '.cache.json'));
        service = new SynaipseService(config);
        await service.start();

        const handler = buildMcpHttpHandler(config, service, {basePath: '/mcp', eventsUrl: null});
        const req = mockReq('/mcp');
        const res = mockRes();
        handler(req, res as never);

        expect(res.statusCode).not.toBe(401);
    });

    it('returns 404 for paths outside basePath even when token is configured', async () => {
        const config = buildConfig(vaultDir, path.join(vaultDir, '.cache.json'), 'sekret-token');
        service = new SynaipseService(config);
        await service.start();

        const handler = buildMcpHttpHandler(config, service, {basePath: '/mcp', eventsUrl: null});
        const req = mockReq('/other');
        const res = mockRes();
        handler(req, res as never);

        expect(res.statusCode).toBe(404);
    });

    it('rejects token comparison resistant to length differences', async () => {
        const config = buildConfig(vaultDir, path.join(vaultDir, '.cache.json'), 'long-secret-token');
        service = new SynaipseService(config);
        await service.start();

        const handler = buildMcpHttpHandler(config, service, {basePath: '/mcp', eventsUrl: null});
        const req = mockReq('/mcp', {authorization: 'Bearer short'});
        const res = mockRes();
        handler(req, res as never);

        expect(res.statusCode).toBe(401);
    });

    it('lets a granular tokens-list match through', async () => {
        const config: Config = {
            ...buildConfig(vaultDir, path.join(vaultDir, '.cache.json')),
            server: {
                name: 'synaipse-test',
                version: '0.0.0',
                tokens: [{
                    token: 'reader-token',
                    label: 'reader',
                    read: true,
                    pathPrefixes: ['Memory/']
                }]
            }
        };
        service = new SynaipseService(config);
        await service.start();

        const handler = buildMcpHttpHandler(config, service, {basePath: '/mcp', eventsUrl: null});
        const req = mockReq('/mcp', {authorization: 'Bearer reader-token'});
        const res = mockRes();
        handler(req, res as never);

        expect(res.statusCode).not.toBe(401);
    });

    it('rejects an unknown token when only granular tokens are configured', async () => {
        const config: Config = {
            ...buildConfig(vaultDir, path.join(vaultDir, '.cache.json')),
            server: {
                name: 'synaipse-test',
                version: '0.0.0',
                tokens: [{token: 'reader-token', read: true}]
            }
        };
        service = new SynaipseService(config);
        await service.start();

        const handler = buildMcpHttpHandler(config, service, {basePath: '/mcp', eventsUrl: null});
        const req = mockReq('/mcp', {authorization: 'Bearer not-the-token'});
        const res = mockRes();
        handler(req, res as never);

        expect(res.statusCode).toBe(401);
    });
});