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

/** Plan P8 / B4 S2: search and read_note tell the agent when knowledge is outdated. */

let vaultDir: string;
let service: SynaipseService;
let client: Client;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-mcp-knowledge-'));
    const config = {
        vaultPath: vaultDir,
        indexCachePath: path.join(vaultDir, '.cache.json'),
        chatStoreDir: path.join(vaultDir, '..', 'chats'),
        auditLogPath: path.join(vaultDir, '.audit.jsonl'),
        embeddings: {provider: 'none' as const},
        qdrant: {url: 'http://127.0.0.1:9', collection: 'test'},
        server: {name: 'synaipse-test', version: '0.0.0'},
        web: {port: 0}
    };
    service = new SynaipseService(config);
    await service.start();
    await service.writeNote({path: 'Memory/demo/old.md', content: 'Sessions live in Redis.', frontmatter: {title: 'Sessions in Redis'}}, {project: 'demo'});
    await service.writeNote({path: 'Memory/demo/new.md', content: 'Sessions live in Postgres.', frontmatter: {title: 'Sessions in Postgres', supersedes: ['Sessions in Redis']}}, {project: 'demo'});
    await service.writeNote({path: 'Memory/demo/gone.md', content: 'Old phone number.', frontmatter: {title: 'Phone', valid_until: '2020-01-01'}}, {project: 'demo'});

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

const json = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await client.callTool({name, arguments: args});
    return JSON.parse((result.content as Array<{text: string}>)[0]!.text) as Record<string, unknown>;
};

describe('knowledge state over MCP', () => {
    it('search puts the successor first and marks the superseded hit', async () => {
        const {hits} = await json('synaipse_search', {query: 'Redis sessions'}) as {hits: Array<Record<string, unknown>>};

        expect(hits[0]?.noteId).toBe('Memory/demo/new.md');
        expect(hits.find((h) => h.noteId === 'Memory/demo/old.md')).toMatchObject({supersededBy: 'Memory/demo/new.md'});
    });

    it('read_note names the successor and flags expired notes; current notes carry neither', async () => {
        expect((await json('synaipse_read_note', {id: 'Memory/demo/old.md'})).note).toMatchObject({supersededBy: 'Memory/demo/new.md'});
        expect((await json('synaipse_read_note', {id: 'Phone'})).note).toMatchObject({expired: true});

        const current = (await json('synaipse_read_note', {id: 'Memory/demo/new.md'})).note as Record<string, unknown>;
        expect(current.supersededBy).toBeUndefined();
        expect(current.expired).toBeUndefined();
    });
});
