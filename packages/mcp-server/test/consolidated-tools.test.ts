import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {SynaipseService} from '@synaipse/service';
import {buildTools, DEPRECATED_TOOLS, resolveToolsets, TOOLSETS, type ToolHandler} from '../src/Tools.js';
import {buildMcpServer} from '../src/Server.js';
import {EventPublisher} from '../src/EventPublisher.js';

/** Plan P2 / B2: consolidated list/links/graph, hidden aliases, toolsets. */

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

const writeNote = async (root: string, relPath: string, body: string, mtime?: number): Promise<void> => {
    const absolute = path.join(root, relPath);
    await mkdir(path.dirname(absolute), {recursive: true});
    await writeFile(absolute, body, 'utf8');
    if (mtime !== undefined) {
        const {utimes} = await import('node:fs/promises');
        await utimes(absolute, mtime / 1000, mtime / 1000);
    }
};

let vaultDir: string;
let service: SynaipseService;
let tools: Map<string, ToolHandler>;

const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const outcome = await tools.get(name)!.handle(args, {});
    return JSON.parse(outcome.response.content[0]!.text);
};

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-consolidated-'));
    // Chain a → b → c → d plus an unrelated hub-less note e.
    await writeNote(vaultDir, 'n/a.md', '---\ntitle: A\ntags: [x]\n---\n[[B]] [[Missing]]', 1_000_000);
    await writeNote(vaultDir, 'n/b.md', '---\ntitle: B\ntags: [x]\n---\n[[C]]', 2_000_000);
    await writeNote(vaultDir, 'n/c.md', '---\ntitle: C\n---\n[[D]]', 3_000_000);
    await writeNote(vaultDir, 'n/d.md', '---\ntitle: D\nlinks:\n  - target: A\n    kind: supersedes\n---\nend', 4_000_000);
    await writeNote(vaultDir, 'other/e.md', '---\ntitle: E\n---\nalone', 5_000_000);
    service = new SynaipseService(buildConfig(vaultDir));
    await service.start();
    tools = new Map(buildTools(service, {toolsets: TOOLSETS}).map((t) => [t.definition.name, t]));
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('synaipse_list', () => {
    it('defaults to newest first and pages with a cursor', async () => {
        const first = await call('synaipse_list', {limit: 2});
        expect(first.notes.map((n: any) => n.id)).toEqual(['other/e.md', 'n/d.md']);
        expect(first.total).toBe(5);
        const second = await call('synaipse_list', {limit: 2, cursor: first.nextCursor});
        expect(second.notes.map((n: any) => n.id)).toEqual(['n/c.md', 'n/b.md']);
        const last = await call('synaipse_list', {limit: 2, cursor: second.nextCursor});
        expect(last.nextCursor).toBeUndefined();
    });

    it('filters by prefix and tag, sorts by title', async () => {
        const tagged = await call('synaipse_list', {tag: 'x', sort: 'title'});
        expect(tagged.notes.map((n: any) => n.title)).toEqual(['A', 'B']);
        const folder = await call('synaipse_list', {prefix: 'other/'});
        expect(folder.notes.map((n: any) => n.id)).toEqual(['other/e.md']);
    });

    it('rejects an unknown sort', async () => {
        await expect(call('synaipse_list', {sort: 'size'})).rejects.toThrow(/Invalid sort/);
    });
});

describe('synaipse_links', () => {
    it('returns in, out, unresolved and typed links', async () => {
        const both = await call('synaipse_links', {id: 'A'});
        expect(both).toMatchObject({id: 'n/a.md', in: [], out: ['B', 'Missing'], unresolved: ['Missing']});
        const d = await call('synaipse_links', {id: 'n/d.md', direction: 'out'});
        expect(d.typed).toEqual([{target: 'A', kind: 'supersedes'}]);
        expect(d.in).toBeUndefined();
        const c = await call('synaipse_links', {id: 'n/c.md', direction: 'in'});
        expect(c.in).toEqual(['n/b.md']);
        expect(c.out).toBeUndefined();
    });
});

describe('synaipse_graph', () => {
    it('returns the neighbourhood of a center up to depth', async () => {
        const one = await call('synaipse_graph', {center: 'B'});
        expect(one.nodes.map((n: any) => n.id).sort()).toEqual(['n/a.md', 'n/b.md', 'n/c.md']);
        expect(one.edges).toContainEqual(['n/a.md', 'n/b.md']);
        const two = await call('synaipse_graph', {center: 'B', depth: 2});
        expect(two.nodes.map((n: any) => n.id).sort()).toEqual(['n/a.md', 'n/b.md', 'n/c.md', 'n/d.md']);
    });

    it('is bounded by limit and says so', async () => {
        const top = await call('synaipse_graph', {limit: 2});
        expect(top.nodes).toHaveLength(2);
        expect(top).toMatchObject({truncated: true, totalNodes: 5});
    });
});

describe('deprecated aliases and toolsets', () => {
    it('keeps deprecated tools callable but out of tools/list', async () => {
        const server = buildMcpServer(buildConfig(vaultDir), [...tools.values()], new EventPublisher(null), null);
        const [a, b] = InMemoryTransport.createLinkedPair();
        const client = new Client({name: 't', version: '0'});
        await Promise.all([server.connect(b), client.connect(a)]);

        const listed = new Set((await client.listTools()).tools.map((t) => t.name));
        for (const [old, replacement] of Object.entries(DEPRECATED_TOOLS)) {
            expect(listed.has(old), old).toBe(false);
            expect(listed.has(replacement), replacement).toBe(true);
        }
        const result = await client.callTool({name: 'synaipse_backlinks', arguments: {id: 'n/c.md'}});
        expect(result.isError).toBeFalsy();
        await client.close();
    });

    it('registers admin tools only when the admin toolset is enabled', () => {
        const names = (sets?: Parameters<typeof buildTools>[1]) => new Set(buildTools(service, sets).map((t) => t.definition.name));
        expect(names({toolsets: ['core']}).has('synaipse_verify_history')).toBe(false);
        expect(names({toolsets: ['core']}).has('synaipse_roadmap_get')).toBe(false);
        expect(names({toolsets: ['core', 'admin']}).has('synaipse_verify_history')).toBe(true);
    });

    it('parses SYNAIPSE_MCP_TOOLSETS', () => {
        expect(resolveToolsets(undefined)).toEqual(['core', 'roadmap', 'benchmark']);
        expect(resolveToolsets('all')).toEqual(TOOLSETS);
        expect(resolveToolsets('admin')).toEqual(['core', 'admin']);
    });
});
