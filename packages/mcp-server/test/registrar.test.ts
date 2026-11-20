import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {ElicitRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {SynaipseService} from '@synaipse/service';
import {buildTools} from '../src/Tools.js';
import {createSynaipseRegistrar, type SynaipseRegistrar} from '../src/Registrar.js';

/** Plan P9 S2: Synaipse tools on a host gateway's McpServer, next to the host's own tools. */

let vaultDir: string;
let service: SynaipseService;
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

/** What PKG Studio's mountMcp does per session: a fresh McpServer, the host's tools, then every registrar. */
const gateway = async (registrar: SynaipseRegistrar, answer?: 'accept' | 'decline'): Promise<Client> => {
    const server = new McpServer({name: 'pkgstudio', version: '0.0.0'});
    server.registerTool('host_ping', {description: 'host tool', inputSchema: {}}, async () => ({content: [{type: 'text', text: 'pong'}]}));
    registrar(server);

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({name: 'test', version: '0.0.0'}, {capabilities: answer === undefined ? {} : {elicitation: {}}});
    if (answer !== undefined) client.setRequestHandler(ElicitRequestSchema, async () => ({action: answer}));
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    opened.push(client);
    return client;
};

const text = (result: Awaited<ReturnType<Client['callTool']>>): string => (result.content as Array<{text: string}>)[0]!.text;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-mcp-p9-'));
    service = new SynaipseService(config());
    await service.start();
    await service.writeNote({path: 'deploy.md', content: 'Deploy with the blue-green switch.', frontmatter: {title: 'Deploy runbook'}}, {project: 'demo'});
});

afterEach(async () => {
    await Promise.all(opened.splice(0).map((c) => c.close()));
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('createSynaipseRegistrar', () => {
    it('lists every visible Synaipse tool beside the host tools, with converted schemas', async () => {
        const client = await gateway(createSynaipseRegistrar(service, {project: 'demo', toolsets: ['core']}));
        const listed = (await client.listTools()).tools;
        const own = buildTools(service, {toolsets: ['core']});

        expect(listed.map((t) => t.name)).toContain('host_ping');
        expect(listed.filter((t) => t.name.startsWith('synaipse_')).map((t) => t.name).sort()).toEqual(own.map((t) => t.definition.name).sort());

        // Required fields and property names survive the JSON Schema → zod → JSON Schema round trip.
        for (const tool of own) {
            const back = listed.find((t) => t.name === tool.definition.name)!;
            const original = tool.definition.inputSchema as {properties?: Record<string, unknown>; required?: string[]};
            expect(Object.keys(back.inputSchema.properties ?? {}).sort(), tool.definition.name).toEqual(Object.keys(original.properties ?? {}).sort());
            expect([...(back.inputSchema.required ?? [])].sort(), tool.definition.name).toEqual([...(original.required ?? [])].sort());
        }
    });

    it('runs tools in the configured project, with a resource link on writes', async () => {
        const client = await gateway(createSynaipseRegistrar(service, {project: 'demo', toolsets: ['core']}));

        const read = await client.callTool({name: 'synaipse_read_note', arguments: {id: 'Memory/demo/deploy.md'}});
        expect(read.isError).toBeFalsy();
        expect(text(read)).toContain('blue-green');

        const write = await client.callTool({name: 'synaipse_write_note', arguments: {path: 'gateway.md', content: 'from the gateway', title: 'Gateway note'}});
        expect(write.isError).toBeFalsy();
        expect(service.tryReadNote('Memory/demo/gateway.md')).toBeDefined();
        expect((write.content as Array<{type: string}>).some((c) => c.type === 'resource_link')).toBe(true);
    });

    it('rejects arguments the schema forbids and keeps tool errors as tool errors', async () => {
        const client = await gateway(createSynaipseRegistrar(service, {project: 'demo', toolsets: ['core']}));

        const bad = await client.callTool({name: 'synaipse_read_note', arguments: {id: 42}});
        expect(bad.isError).toBe(true);

        const missing = await client.callTool({name: 'synaipse_read_note', arguments: {id: 'Memory/demo/nope.md'}});
        expect(missing.isError).toBe(true);
    });

    it('asks for confirmation through the gateway session', async () => {
        const declining = await gateway(createSynaipseRegistrar(service, {project: 'demo', toolsets: ['core']}), 'decline');
        const result = await declining.callTool({name: 'synaipse_delete_note', arguments: {id: 'Memory/demo/deploy.md'}});
        expect(JSON.parse(text(result))).toMatchObject({deleted: false});
        expect(service.tryReadNote('Memory/demo/deploy.md')).toBeDefined();
    });

    it('one registrar serves many sessions (the gateway builds a server per session)', async () => {
        const registrar = createSynaipseRegistrar(service, {project: 'demo', toolsets: ['core']});
        const [a, b] = [await gateway(registrar), await gateway(registrar)];
        expect((await a.callTool({name: 'host_ping', arguments: {}})).isError).toBeFalsy();
        expect((await b.callTool({name: 'synaipse_read_note', arguments: {id: 'Memory/demo/deploy.md'}})).isError).toBeFalsy();
    });
});
