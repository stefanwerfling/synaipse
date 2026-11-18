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
import {NO_AUTH_SCOPE, type TokenScope} from '../src/Auth.js';
import {noteUri} from '../src/Resources.js';

/** Plan P8 S5: resources, prompts, completions, outputSchema/structuredContent, resource_link. */

let vaultDir: string;
let service: SynaipseService;
let client: Client;
const P = {project: 'demo'};

const config = () => ({
    vaultPath: vaultDir,
    indexCachePath: path.join(vaultDir, '.cache.json'),
    chatStoreDir: path.join(vaultDir, '..', 'chats'),
    auditLogPath: path.join(vaultDir, '.audit.jsonl'),
    schedulesPath: path.join(vaultDir, '..', 'schedules.json'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://127.0.0.1:9', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0}
});

const connect = async (scope: TokenScope = NO_AUTH_SCOPE, project: string | null = 'demo'): Promise<Client> => {
    const server = buildMcpServer(config(), buildTools(service), new EventPublisher(null), project, project === null ? {} : {project}, scope, service);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const c = new Client({name: 'test', version: '0.0.0'});
    await Promise.all([server.connect(serverSide), c.connect(clientSide)]);
    return c;
};

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-mcp-s5-'));
    service = new SynaipseService(config());
    await service.start();
    await service.writeNote({path: 'decisions/cache.md', content: '## Decision\n\nRedis with a 24 h TTL.', frontmatter: {title: 'Cache in Redis', tags: ['cache']}}, P);
    await service.writeNote({path: 'with space.md', content: 'Spaces in the path.', frontmatter: {title: 'Spaced'}}, P);
    await service.writeNote({path: 'secret.md', content: 'Other project.', frontmatter: {title: 'Secret'}}, {project: 'other'});
    client = await connect();
});

afterEach(async () => {
    await client.close();
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('resources', () => {
    it('lists project resources and notes, reads a note as markdown', async () => {
        expect(client.getServerCapabilities()).toMatchObject({resources: {}, prompts: {}, completions: {}});

        const {resources} = await client.listResources();
        const uris = resources.map((r) => r.uri);
        expect(uris.slice(0, 3)).toEqual(['synaipse://project/demo/primer', 'synaipse://project/demo/convention', 'synaipse://project/demo/roadmap']);
        expect(uris).toContain('synaipse://note/Memory/demo/with%20space.md');

        const note = await client.readResource({uri: noteUri('Memory/demo/with space.md')});
        expect(note.contents[0]).toMatchObject({mimeType: 'text/markdown', text: 'Spaces in the path.\n'});

        const templates = await client.listResourceTemplates();
        expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toContain('synaipse://note/{+path}');
    });

    it('reads primer, convention and roadmap through the tools', async () => {
        const primer = await client.readResource({uri: 'synaipse://project/demo/primer'});
        expect(JSON.parse((primer.contents[0] as {text: string}).text)).toHaveProperty('context');

        const convention = await client.readResource({uri: 'synaipse://project/demo/convention'});
        expect((convention.contents[0] as {text: string}).text).toContain('Memory/demo/');

        const roadmap = await client.readResource({uri: 'synaipse://project/demo/roadmap'});
        expect(roadmap.contents[0]!.mimeType).toBe('application/json');
    });

    it('errors on unknown notes and uris', async () => {
        await expect(client.readResource({uri: 'synaipse://note/Memory/demo/nope.md'})).rejects.toThrow(/not found/i);
        await expect(client.readResource({uri: 'synaipse://elsewhere/x'})).rejects.toThrow(/Unknown resource/);
    });

    it('respects the token path scope like the tools do', async () => {
        const scoped = await connect({...NO_AUTH_SCOPE, label: 'scoped', pathPrefixes: ['Memory/demo/']});
        const {resources} = await scoped.listResources();
        expect(resources.map((r) => r.uri).some((u) => u.includes('/other/'))).toBe(false);
        await expect(scoped.readResource({uri: noteUri('Memory/other/secret.md')})).rejects.toThrow(/Forbidden/);

        const noRead = await connect({...NO_AUTH_SCOPE, label: 'w', read: false});
        expect((await noRead.listResources()).resources).toEqual([]);
        await scoped.close();
        await noRead.close();
    });
});

describe('prompts', () => {
    it('lists the four prompts and fills arguments; project prompts need a project', async () => {
        const {prompts} = await client.listPrompts();
        expect(prompts.map((p) => p.name)).toEqual(['session-to-vault', 'consolidate-inbox', 'record-adr', 'roadmap-review']);

        const adr = await client.getPrompt({name: 'record-adr', arguments: {title: 'Use Redis'}});
        const text = (adr.messages[0]!.content as {text: string}).text;
        expect(text).toContain('"Use Redis"');
        expect(text).toContain('synaipse_write_note');
        await expect(client.getPrompt({name: 'record-adr', arguments: {}})).rejects.toThrow(/title/);

        const noProject = await connect(NO_AUTH_SCOPE, null);
        expect((await noProject.listPrompts()).prompts.map((p) => p.name)).toEqual(['session-to-vault', 'record-adr']);
        await noProject.close();
    });
});

describe('completions', () => {
    it('completes note paths, projects and since', async () => {
        const paths = await client.complete({ref: {type: 'ref/resource', uri: 'synaipse://note/{+path}'}, argument: {name: 'path', value: 'Memory/demo/'}});
        expect(paths.completion.values).toEqual(['Memory/demo/decisions/cache.md', 'Memory/demo/with space.md']);
        const anywhere = await client.complete({ref: {type: 'ref/resource', uri: 'synaipse://note/{+path}'}, argument: {name: 'path', value: 'cache'}});
        expect(anywhere.completion.values).toEqual(['Memory/demo/decisions/cache.md']);

        const projects = await client.complete({ref: {type: 'ref/resource', uri: 'synaipse://project/{project}/primer'}, argument: {name: 'project', value: ''}});
        expect(projects.completion.values).toEqual(['demo', 'other']);

        const since = await client.complete({ref: {type: 'ref/prompt', name: 'consolidate-inbox'}, argument: {name: 'since', value: '1'}});
        expect(since.completion.values).toEqual(['1d', '14d']);
    });
});

describe('structured output', () => {
    it('declares outputSchema and returns matching structuredContent (validated by the SDK client)', async () => {
        const {tools} = await client.listTools();
        const search = tools.find((t) => t.name === 'synaipse_search');
        expect(search?.outputSchema).toMatchObject({type: 'object', required: ['hits']});

        for (const [name, args] of [
            ['synaipse_search', {query: 'redis cache'}],
            ['synaipse_read_note', {id: 'Memory/demo/decisions/cache.md'}],
            ['synaipse_list', {since: '1h'}],
            ['synaipse_note_history', {id: 'Memory/demo/decisions/cache.md'}]
        ] as const) {
            const result = await client.callTool({name, arguments: args});
            expect(result.isError, name).toBeFalsy();
            expect(result.structuredContent, name).toEqual(JSON.parse((result.content as Array<{text: string}>)[0]!.text));
        }

        const missing = await client.callTool({name: 'synaipse_read_note', arguments: {id: 'nope'}});
        expect(missing.isError).toBe(true);
        expect(missing.structuredContent).toBeUndefined();
    });

    it('write results carry a resource_link to the note', async () => {
        await client.listTools();
        const result = await client.callTool({name: 'synaipse_write_note', arguments: {path: 'new.md', content: 'x'}});
        const content = result.content as Array<{type: string; uri?: string}>;
        expect(content[1]).toMatchObject({type: 'resource_link', uri: 'synaipse://note/Memory/demo/new.md'});
        expect(result.structuredContent).toMatchObject({id: 'Memory/demo/new.md'});
    });
});
