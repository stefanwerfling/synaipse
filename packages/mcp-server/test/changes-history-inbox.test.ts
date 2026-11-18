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

/** Plan P8 S4 over MCP: list since, search filters + sections, note_history, consolidate_inbox. */

let vaultDir: string;
let service: SynaipseService;
let client: Client;
const P = {project: 'demo'};

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-mcp-s4-'));
    const config = {
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
    };
    service = new SynaipseService(config);
    await service.start();

    const server = buildMcpServer(config, buildTools(service), new EventPublisher(null), 'demo', P);
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

describe('what changed', () => {
    it('list with since returns changed notes and removed ones; bad since is an error', async () => {
        await service.writeNote({path: 'kept.md', content: 'x'}, P);
        await service.writeNote({path: 'gone.md', content: 'x'}, P);
        await service.deleteNote('Memory/demo/gone.md', P);

        const {json} = await call('synaipse_list', {since: '1h', prefix: 'Memory/demo/'});
        expect((json.notes as Array<{id: string}>).map((n) => n.id)).toEqual(['Memory/demo/kept.md']);
        expect(json.removed).toEqual([expect.objectContaining({id: 'Memory/demo/gone.md', how: 'deleted'})]);

        expect((await call('synaipse_list', {since: '2999-01-01'})).json.notes).toEqual([]);
        expect((await call('synaipse_list', {since: 'yesterday-ish'})).error).toBe(true);
        expect((await call('synaipse_list', {})).json.removed).toBeUndefined();
    });
});

describe('search filters and sections', () => {
    it('filters by tags and points at the matching section', async () => {
        await service.writeNote({path: 'runbook.md', content: '## Deploy\n\nApprove the stage.\n\n## Rollback\n\nRe-run the previous tag to roll back a release.', frontmatter: {title: 'Runbook', tags: ['ops']}}, P);
        await service.writeNote({path: 'other.md', content: 'Roll back the release by hand.', frontmatter: {title: 'Other'}}, P);

        const {json} = await call('synaipse_search', {query: 'roll back release', tags: ['ops']});
        const hits = json.hits as Array<Record<string, unknown>>;
        expect(hits.map((h) => h.noteId)).toEqual(['Memory/demo/runbook.md']);
        expect(hits[0]).toMatchObject({section: 'Rollback', lines: [5, 8]});

        const section = await call('synaipse_read_note', {id: 'Memory/demo/runbook.md', section: 'Rollback'});
        expect((section.json.note as {content: string}).content).toContain('previous tag');
    });
});

describe('note_history', () => {
    it('lists versions with the tool and diffs an older one against now', async () => {
        await service.writeNote({path: 'h.md', content: 'first line'}, P);
        await service.updateNote('Memory/demo/h.md', {content: 'second line'}, P);

        const {json} = await call('synaipse_note_history', {id: 'Memory/demo/h.md'});
        const versions = json.versions as Array<{sha: string; tool: string}>;
        expect(versions.map((v) => v.tool)).toEqual(['update_note', 'write_note']);
        expect(versions[0]!.sha).toHaveLength(10);

        const diff = await call('synaipse_note_history', {id: 'Memory/demo/h.md', diff: versions[1]!.sha});
        expect(diff.json.diff).toContain('-first line');
        expect(diff.json.diff).toContain('+second line');
        expect((await call('synaipse_note_history', {id: 'Memory/demo/h.md', diff: 'ffffffff'})).error).toBe(true);
    });
});

describe('consolidate_inbox', () => {
    it('returns entries with alreadyIn and targets', async () => {
        await service.writeNote({path: 'decisions/cache.md', content: 'The cache lives in Redis with a 24 hour TTL and LRU eviction.', frontmatter: {title: 'Cache in Redis'}}, P);
        await call('synaipse_remember', {text: 'Cache lives in Redis with a 24 hour TTL.'});

        const {json} = await call('synaipse_consolidate_inbox', {});
        const entries = json.entries as Array<Record<string, unknown>>;
        expect(json.total).toBe(1);
        expect(entries[0]).toMatchObject({text: 'Cache lives in Redis with a 24 hour TTL.', alreadyIn: [expect.objectContaining({id: 'Memory/demo/decisions/cache.md'})]});
        expect(String(entries[0]!.section)).toMatch(/^\d{2}:\d{2}$/);
    });
});
