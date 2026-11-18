import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {SynaipseService} from '@synaipse/service';
import {buildTools} from '../src/Tools.js';
import {buildMcpServer} from '../src/Server.js';
import {EventPublisher} from '../src/EventPublisher.js';

/** Plan P8 / B4 S3 over MCP: modes, expectedHash, possibleDuplicates. */

let vaultDir: string;
let service: SynaipseService;
let client: Client;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-mcp-guard-'));
    const config = {
        vaultPath: vaultDir,
        indexCachePath: path.join(vaultDir, '.cache.json'),
        chatStoreDir: path.join(vaultDir, '..', 'chats'),
        auditLogPath: path.join(vaultDir, '.audit.jsonl'),
        schedulesPath: path.join(vaultDir, '..', 'schedules.json'),
        embeddings: {provider: 'none' as const},
        qdrant: {url: 'http://127.0.0.1:9', collection: 'test'},
        server: {name: 'synaipse-test', version: '0.0.0'},
        web: {port: 0}
    };
    service = new SynaipseService(config);
    await service.start();
    await service.writeNote({path: 'cache.md', content: 'The cache lives in Redis with a 24 hour TTL and LRU eviction.', frontmatter: {title: 'Cache in Redis'}}, {project: 'demo'});

    const server = buildMcpServer(config, buildTools(service), new EventPublisher(null), 'demo', {project: 'demo'});
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    client = new Client({name: 'test', version: '0.0.0'});
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterEach(async () => {
    await client.close();
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

const call = async (name: string, args: Record<string, unknown>): Promise<{error: boolean; text: string; json: Record<string, unknown>}> => {
    const result = await client.callTool({name, arguments: args});
    const text = (result.content as Array<{text: string}>)[0]!.text;
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* error text */ }
    return {error: result.isError === true, text, json};
};

describe('write_note guards over MCP', () => {
    it('reports created and possible duplicates for a new note, nothing extra for an overwrite', async () => {
        const fresh = await call('synaipse_write_note', {path: 'redis-cache.md', content: 'Our cache lives in Redis, 24 hour TTL, LRU eviction.', frontmatter: {title: 'Redis cache'}});
        expect(fresh.json).toMatchObject({created: true, possibleDuplicates: [{id: 'Memory/demo/cache.md', title: 'Cache in Redis'}]});

        const again = await call('synaipse_write_note', {path: 'redis-cache.md', content: 'Changed.', frontmatter: {title: 'Redis cache'}});
        expect(again.json.created).toBeUndefined();
        expect(again.json.possibleDuplicates).toBeUndefined();
    });

    it('turns guard failures into tool errors and rejects an unknown mode', async () => {
        const exists = await call('synaipse_write_note', {path: 'cache.md', content: 'x', mode: 'create'});
        expect(exists.error).toBe(true);
        expect(exists.text).toContain('already exists');

        const stale = await call('synaipse_write_note', {path: 'cache.md', content: 'x', expectedHash: 'nope'});
        expect(stale.error).toBe(true);
        expect(stale.text).toContain('changed since you read it');

        const bad = await call('synaipse_write_note', {path: 'x.md', content: 'x', mode: 'replace'});
        expect(bad.error).toBe(true);
        expect(bad.text).toContain('Invalid mode');
        expect(service.tryReadNote('Memory/demo/x.md')).toBeUndefined();
    });

    it('update_note and edit_note honour expectedHash', async () => {
        const {hash} = (await call('synaipse_read_note', {id: 'Memory/demo/cache.md'})).json.note as {hash: string};

        expect((await call('synaipse_edit_note', {id: 'Memory/demo/cache.md', edits: [{oldString: 'Redis', newString: 'Valkey', replaceAll: true}], expectedHash: 'old'})).error).toBe(true);
        expect((await call('synaipse_edit_note', {id: 'Memory/demo/cache.md', edits: [{oldString: 'Redis', newString: 'Valkey', replaceAll: true}], expectedHash: hash})).error).toBe(false);
        expect((await call('synaipse_update_note', {id: 'Memory/demo/cache.md', content: 'gone', expectedHash: hash})).error).toBe(true);
    });

    it('remember names a note that already says the same', async () => {
        const result = await call('synaipse_remember', {text: 'Cache lives in Redis with a 24 hour TTL.'});
        expect(result.json.possibleDuplicates).toEqual([expect.objectContaining({id: 'Memory/demo/cache.md'})]);

        const fresh = await call('synaipse_remember', {text: 'The deploy runs on Tuesdays.'});
        expect(fresh.json.possibleDuplicates).toBeUndefined();
    });
});
