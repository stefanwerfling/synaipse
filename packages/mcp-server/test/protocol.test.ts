import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {SynaipseService} from '@synaipse/service';
import {buildTools} from '../src/Tools.js';
import {buildMcpServer} from '../src/Server.js';
import {EventPublisher} from '../src/EventPublisher.js';

/** Plan P2 / B1: initialize instructions, annotations, tool errors, arg validation. */

const buildConfig = (vaultPath: string) => ({
    vaultPath,
    indexCachePath: path.join(vaultPath, '.cache.json'),
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    auditLogPath: path.join(vaultPath, '.audit.jsonl'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://localhost:6333', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0}
});

let vaultDir: string;
let service: SynaipseService;
let client: Client;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-proto-'));
    const config = buildConfig(vaultDir);
    service = new SynaipseService(config);
    await service.start();
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

const text = (result: Awaited<ReturnType<Client['callTool']>>): string =>
    (result.content as Array<{type: string; text: string}>)[0]!.text;

describe('MCP protocol surface', () => {
    it('sends the working protocol as initialize instructions, naming the project folder', () => {
        const instructions = client.getInstructions() ?? '';
        expect(instructions).toContain('synaipse_prime');
        expect(instructions).toContain('Memory/demo/');
    });

    it('derives title + annotations from the ACL table', async () => {
        const {tools} = await client.listTools();
        const byName = new Map(tools.map((t) => [t.name, t]));

        expect(byName.get('synaipse_search')?.annotations).toMatchObject({readOnlyHint: true, openWorldHint: false});
        expect(byName.get('synaipse_delete_note')?.annotations).toMatchObject({readOnlyHint: false, destructiveHint: true, idempotentHint: true});
        expect(byName.get('synaipse_remember')?.annotations).toMatchObject({readOnlyHint: false, destructiveHint: false, idempotentHint: false});
        expect(byName.get('synaipse_roadmap_update_step')?.title).toBe('Roadmap update step');
        for (const t of tools) {
            expect(t.annotations?.readOnlyHint, t.name).toBeTypeOf('boolean');
        }
    });

    it('bounds every limit argument in the schema', async () => {
        const {tools} = await client.listTools();
        const withLimit = tools.filter((t) => (t.inputSchema.properties as Record<string, unknown> | undefined)?.limit !== undefined);
        expect(withLimit.length).toBeGreaterThan(3);
        for (const t of withLimit) {
            expect((t.inputSchema.properties as Record<string, unknown>).limit, t.name)
                .toMatchObject({type: 'integer', minimum: 1, maximum: 500});
        }
    });

    it('reports an unknown tool as a tool error, not a protocol error', async () => {
        const result = await client.callTool({name: 'synaipse_nope', arguments: {}});
        expect(result.isError).toBe(true);
        expect(text(result)).toContain('Unknown tool');
    });

    it('rejects an invalid search mode instead of silently using hybrid', async () => {
        const result = await client.callTool({name: 'synaipse_search', arguments: {query: 'x', mode: 'semantik'}});
        expect(result.isError).toBe(true);
        expect(text(result)).toContain('Invalid mode');
    });

    it('returns compact JSON', async () => {
        const result = await client.callTool({name: 'synaipse_get_project', arguments: {}});
        expect(text(result)).not.toContain('\n');
        expect(JSON.parse(text(result))).toMatchObject({project: 'demo'});
    });
});
