import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SynaipseService, auditContextStorage} from '@synaipse/service';
import {buildTools, EMPTY_CTX, TOOLSETS, type ToolHandler} from '../src/Tools.js';
import {resolvePathArg} from '../src/Server.js';
import {checkScope, type TokenScope} from '../src/Auth.js';

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

const writeNote = async (root: string, relPath: string, body: string): Promise<void> => {
    const absolute = path.join(root, relPath);
    await mkdir(path.dirname(absolute), {recursive: true});
    await writeFile(absolute, body, 'utf8');
};

const scoped: TokenScope = {
    label: 'scoped',
    read: true,
    write: true,
    tools: [],
    pathPrefixes: ['Memory/a/']
};

let vaultDir: string;
let service: SynaipseService;
let tools: ToolHandler[];

const tool = (name: string): ToolHandler => {
    const t = tools.find((x) => x.definition.name === name);
    if (t === undefined) throw new Error(`tool ${name} not found`);
    return t;
};

/** Run a tool as the path-scoped token would (same ALS context as Server.ts). */
const callScoped = async <T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> => {
    const outcome = await auditContextStorage.run(
        {tokenLabel: scoped.label, pathPrefixes: scoped.pathPrefixes},
        () => tool(name).handle(args, EMPTY_CTX)
    );
    return JSON.parse(outcome.response.content[0]!.text) as T;
};

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-acl-'));
    await writeNote(vaultDir, 'Memory/a/one.md', '---\ntitle: One\ntags: [shared]\n---\nalpha [[Two]]\n\n- [ ] todo a');
    await writeNote(vaultDir, 'Memory/b/two.md', '---\ntitle: Two\ntags: [shared, secret]\n---\nalpha [[One]]\n\n- [ ] todo b');
    service = new SynaipseService(buildConfig(vaultDir));
    await service.start();
    tools = buildTools(service, {toolsets: TOOLSETS});
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('ACL table ↔ tool schemas', () => {
    it('every pathArg names a real property of the tool input schema', () => {
        for (const t of tools) {
            if (t.pathArg === undefined) continue;
            const props = (t.definition.inputSchema as {properties?: Record<string, unknown>}).properties ?? {};
            expect(Object.keys(props), `${t.definition.name}.pathArg=${t.pathArg}`).toContain(t.pathArg);
        }
    });

    it('link_note and update_note are checked against the path scope', () => {
        expect(tool('synaipse_link_note').pathArg).toBe('fromId');
        expect(tool('synaipse_update_note').pathArg).toBe('id');
    });
});

describe('resolvePathArg (fail-closed)', () => {
    it('returns empty string when a required path field is missing → denied for scoped tokens', () => {
        const t = tool('synaipse_link_note');
        const resolved = resolvePathArg(t, {toTitles: ['x']});
        expect(resolved).toBe('');
        expect(checkScope(scoped, {name: t.definition.name, mode: 'write'}, resolved)).not.toBeNull();
    });

    it('leaves optional path fields unchecked when absent', () => {
        expect(resolvePathArg(tool('synaipse_write_asset'), {data: '', contentType: 'image/png'})).toBeUndefined();
    });

    it('denies out-of-scope link_note source', () => {
        const t = tool('synaipse_link_note');
        expect(checkScope(scoped, {name: t.definition.name, mode: 'write'}, resolvePathArg(t, {fromId: 'Memory/b/two.md'}))).not.toBeNull();
        expect(checkScope(scoped, {name: t.definition.name, mode: 'write'}, resolvePathArg(t, {fromId: 'Memory/a/one.md'}))).toBeNull();
    });
});

describe('unscopedOnly tools', () => {
    it('history forensics tools are denied for path-scoped tokens', () => {
        for (const name of ['synaipse_verify_history', 'synaipse_snapshot_list']) {
            const t = tool(name);
            expect(t.unscopedOnly).toBe(true);
            expect(checkScope(scoped, {name, mode: 'read', unscopedOnly: true}, undefined)).not.toBeNull();
        }
    });
});

describe('aggregate tools respect the path-prefix scope', () => {
    it('search', async () => {
        const res = await callScoped<{hits: Array<{noteId: string}>}>('synaipse_search', {query: 'alpha', mode: 'fulltext'});
        expect(res.hits.map((h) => h.noteId)).toEqual(['Memory/a/one.md']);
    });

    it('list (by modified, by title, by tag)', async () => {
        const list = await callScoped<{notes: Array<{id: string}>}>('synaipse_list', {});
        expect(list.notes.map((n) => n.id)).toEqual(['Memory/a/one.md']);
        const byTitle = await callScoped<{notes: Array<{id: string}>}>('synaipse_list', {sort: 'title'});
        expect(byTitle.notes.map((n) => n.id)).toEqual(['Memory/a/one.md']);
        const byTag = await callScoped<{notes: Array<{id: string}>}>('synaipse_list', {tag: 'shared'});
        expect(byTag.notes.map((n) => n.id)).toEqual(['Memory/a/one.md']);
    });

    it('list_tags hides tags that only occur outside the scope', async () => {
        const res = await callScoped<{tags: Array<{tag: string; count: number}>}>('synaipse_list_tags', {});
        expect(res.tags).toEqual([{tag: 'shared', count: 1}]);
    });

    it('graph keeps only in-scope nodes and edges', async () => {
        const res = await callScoped<{nodes: Array<{id: string}>; edges: Array<[string, string]>}>('synaipse_graph', {});
        expect(res.nodes.map((n) => n.id)).toEqual(['Memory/a/one.md']);
        expect(res.edges).toEqual([]);
        // An out-of-scope center is invisible, not a leak.
        await expect(callScoped('synaipse_graph', {center: 'Memory/b/two.md'})).rejects.toThrow(/not found/);
        const links = await callScoped<{in: string[]}>('synaipse_links', {id: 'Memory/a/one.md', direction: 'in'});
        expect(links.in).toEqual([]);
    });

    it('todos and backlinks', async () => {
        const todos = await callScoped<{todos: Array<{noteId: string}>}>('synaipse_todos', {});
        expect(new Set(todos.todos.map((t) => t.noteId))).toEqual(new Set(['Memory/a/one.md']));
        const back = await callScoped<{in: string[]}>('synaipse_links', {id: 'Memory/a/one.md', direction: 'in'});
        expect(back.in).toEqual([]);
    });

    it('unscoped callers still see everything', async () => {
        const outcome = await tool('synaipse_list').handle({}, EMPTY_CTX);
        const res = JSON.parse(outcome.response.content[0]!.text) as {notes: unknown[]};
        expect(res.notes).toHaveLength(2);
    });
});

describe('edit_note consent gate', () => {
    it('refuses to edit (and echo) a note whose consent is denied', async () => {
        await writeNote(vaultDir, 'Memory/a/locked.md', '---\ntitle: Locked\nmcp_consent: denied\n---\nsecret body');
        await service.stop();
        service = new SynaipseService(buildConfig(vaultDir));
        await service.start();
        tools = buildTools(service, {toolsets: TOOLSETS});
        const outcome = await tool('synaipse_edit_note').handle(
            {id: 'Memory/a/locked.md', edits: [{oldString: 'secret', newString: 'x'}]},
            EMPTY_CTX
        ).catch((e: unknown) => e);
        expect(outcome).toBeInstanceOf(Error);
        expect(String(outcome)).toMatch(/denied/);
    });
});
