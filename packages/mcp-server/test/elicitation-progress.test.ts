import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ElicitRequestSchema, type Progress} from '@modelcontextprotocol/sdk/types.js';
import {SynaipseService} from '@synaipse/service';
import {buildTools} from '../src/Tools.js';
import {buildMcpServer} from '../src/Server.js';
import {EventPublisher} from '../src/EventPublisher.js';
import {NO_AUTH_SCOPE} from '../src/Auth.js';

/** Plan P8 S6: delete confirmation by elicitation, progress while waiting for consent. */

let vaultDir: string;
let service: SynaipseService;
const P = {project: 'demo'};
const opened: Client[] = [];

const config = () => ({
    vaultPath: vaultDir,
    indexCachePath: path.join(vaultDir, '.cache.json'),
    chatStoreDir: path.join(vaultDir, '..', 'chats'),
    auditLogPath: path.join(vaultDir, '.audit.jsonl'),
    schedulesPath: path.join(vaultDir, '..', 'schedules.json'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://127.0.0.1:9', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0},
    git: {autoCommit: true, author: {name: 'T', email: 't@local'}}
});

/** A client; with `answer` it supports elicitation and answers every request so. */
const connect = async (answer?: 'accept' | 'decline' | 'cancel', asked: string[] = []): Promise<Client> => {
    const server = buildMcpServer(config(), buildTools(service), new EventPublisher(null), 'demo', P, NO_AUTH_SCOPE, service);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({name: 'test', version: '0.0.0'}, {capabilities: answer === undefined ? {} : {elicitation: {}}});
    if (answer !== undefined) {
        client.setRequestHandler(ElicitRequestSchema, async (request) => {
            asked.push(request.params.message);
            return {action: answer};
        });
    }
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    opened.push(client);
    return client;
};

const json = (result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> =>
    JSON.parse((result.content as Array<{text: string}>)[0]!.text) as Record<string, unknown>;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-mcp-s6-'));
    service = new SynaipseService(config());
    await service.start();
    await service.writeNote({path: 'old.md', content: 'x', frontmatter: {title: 'Old note'}}, P);
});

afterEach(async () => {
    await Promise.all(opened.splice(0).map((c) => c.close()));
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('delete_note confirmation', () => {
    it('asks the user and deletes only on accept', async () => {
        const asked: string[] = [];
        const declining = await connect('decline', asked);
        expect(json(await declining.callTool({name: 'synaipse_delete_note', arguments: {id: 'Memory/demo/old.md'}}))).toEqual({deleted: false, reason: 'declined by the user'});
        expect(service.tryReadNote('Memory/demo/old.md')).toBeDefined();
        expect(asked[0]).toContain('"Old note"');
        expect(asked[0]).toContain('restored from the version history');

        const cancelling = await connect('cancel');
        expect(json(await cancelling.callTool({name: 'synaipse_delete_note', arguments: {id: 'Memory/demo/old.md'}}))).toMatchObject({deleted: false});

        const accepting = await connect('accept');
        expect(json(await accepting.callTool({name: 'synaipse_delete_note', arguments: {id: 'Memory/demo/old.md'}}))).toEqual({deleted: true});
        expect(service.tryReadNote('Memory/demo/old.md')).toBeUndefined();
    });

    it('deletes directly when the client cannot elicit; unknown notes are errors', async () => {
        const plain = await connect();
        expect((await plain.callTool({name: 'synaipse_delete_note', arguments: {id: 'Memory/demo/old.md'}})).isError).toBeFalsy();
        expect(service.tryReadNote('Memory/demo/old.md')).toBeUndefined();

        const asking = await connect('accept');
        expect((await asking.callTool({name: 'synaipse_delete_note', arguments: {id: 'Memory/demo/gone.md'}})).isError).toBe(true);
    });
});

describe('consent wait', () => {
    it('reports progress while the UI decides and returns the note after approval', async () => {
        await service.writeNote({path: 'private.md', content: 'secret', frontmatter: {title: 'Private', mcp_consent: 'pending'}}, P);
        const client = await connect();
        const progress: Progress[] = [];

        const call = client.callTool({name: 'synaipse_read_note', arguments: {id: 'Memory/demo/private.md'}}, undefined, {onprogress: (p) => progress.push(p)});
        await expect.poll(() => service.getConsentStore().pending().length).toBe(1);
        await service.resolveConsent(service.getConsentStore().pending()[0]!.id, 'granted');

        const result = await call;
        expect(result.isError).toBeFalsy();
        expect(progress[0]).toMatchObject({progress: 1, message: expect.stringContaining('Waiting for consent')});
    });
});

describe('over Streamable HTTP', () => {
    it('routes the confirmation through the tool call stream', async () => {
        const http = await import('node:http');
        const {StreamableHTTPClientTransport} = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
        const {buildMcpHttpHandler} = await import('../src/Server.js');

        const handler = buildMcpHttpHandler(config(), service, {basePath: '/mcp', eventsUrl: null});
        const httpServer = http.createServer(handler);
        await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
        const port = (httpServer.address() as {port: number}).port;

        const remote = new Client({name: 'http-test', version: '0.0.0'}, {capabilities: {elicitation: {}}});
        const asked: string[] = [];
        remote.setRequestHandler(ElicitRequestSchema, async (request) => {
            asked.push(request.params.message);
            return {action: 'accept'};
        });
        try {
            await remote.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/demo`)) as Parameters<Client['connect']>[0]);
            expect(json(await remote.callTool({name: 'synaipse_delete_note', arguments: {id: 'Memory/demo/old.md'}}))).toEqual({deleted: true});
            expect(asked).toHaveLength(1);
        } finally {
            await remote.close();
            await handler.closeAll();
            await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        }
    });
});
