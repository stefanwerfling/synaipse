import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, writeFile, mkdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SynaipseService} from '@synaipse/service';
import {buildTools, EMPTY_CTX, type ToolHandler} from '../src/Tools.js';

const buildConfig = (vaultPath: string, indexCachePath: string) => ({
    vaultPath,
    indexCachePath,
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    auditLogPath: path.join(vaultPath, '.audit.jsonl'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://localhost:6333', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0},
    project: {name: 'proj'}
});

const writeNote = async (root: string, relPath: string, body: string): Promise<void> => {
    const absolute = path.join(root, relPath);
    await mkdir(path.dirname(absolute), {recursive: true});
    await writeFile(absolute, body, 'utf8');
};

let vaultDir: string;
let service: SynaipseService;
let edit: ToolHandler;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-tool-edit-'));
    service = new SynaipseService(buildConfig(vaultDir, path.join(vaultDir, '.cache.json')));
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

const setupTool = async (): Promise<void> => {
    await service.start();
    const tool = buildTools(service).find((t) => t.definition.name === 'synaipse_edit_note');
    if (tool === undefined) throw new Error('synaipse_edit_note tool not registered');
    edit = tool;
};

describe('synaipse_edit_note tool', () => {
    it('applies a single unique-match replacement', async () => {
        await writeNote(vaultDir, 'Memory/proj/n.md', '---\ntitle: N\n---\nalpha beta gamma');
        await setupTool();

        const outcome = await edit.handle({
            id: 'Memory/proj/n.md',
            edits: [{oldString: 'beta', newString: 'DELTA'}]
        }, EMPTY_CTX);

        const payload = JSON.parse(outcome.response.content[0]!.text);
        expect(payload.note.content.trimEnd()).toBe('alpha DELTA gamma');

        const onDisk = await readFile(path.join(vaultDir, 'Memory/proj/n.md'), 'utf8');
        expect(onDisk).toContain('alpha DELTA gamma');
    });

    it('applies edits sequentially against the intermediate body', async () => {
        await writeNote(vaultDir, 'Memory/proj/n.md', '---\ntitle: N\n---\nfoo');
        await setupTool();

        const outcome = await edit.handle({
            id: 'Memory/proj/n.md',
            edits: [
                {oldString: 'foo', newString: 'bar'},
                {oldString: 'bar', newString: 'baz'}
            ]
        }, EMPTY_CTX);

        const payload = JSON.parse(outcome.response.content[0]!.text);
        expect(payload.note.content.trimEnd()).toBe('baz');
    });

    it('rejects a non-unique oldString unless replaceAll:true', async () => {
        await writeNote(vaultDir, 'Memory/proj/n.md', '---\ntitle: N\n---\nfoo foo foo');
        await setupTool();

        await expect(edit.handle({
            id: 'Memory/proj/n.md',
            edits: [{oldString: 'foo', newString: 'bar'}]
        }, EMPTY_CTX)).rejects.toThrow(/matches multiple times/);
    });

    it('replaces every occurrence with replaceAll:true', async () => {
        await writeNote(vaultDir, 'Memory/proj/n.md', '---\ntitle: N\n---\nfoo foo foo');
        await setupTool();

        const outcome = await edit.handle({
            id: 'Memory/proj/n.md',
            edits: [{oldString: 'foo', newString: 'bar', replaceAll: true}]
        }, EMPTY_CTX);

        const payload = JSON.parse(outcome.response.content[0]!.text);
        expect(payload.note.content.trimEnd()).toBe('bar bar bar');
    });

    it('throws when oldString is not found', async () => {
        await writeNote(vaultDir, 'Memory/proj/n.md', '---\ntitle: N\n---\nhello');
        await setupTool();

        await expect(edit.handle({
            id: 'Memory/proj/n.md',
            edits: [{oldString: 'nope', newString: 'x'}]
        }, EMPTY_CTX)).rejects.toThrow(/not found/);
    });

    it('rejects empty oldString', async () => {
        await writeNote(vaultDir, 'Memory/proj/n.md', '---\ntitle: N\n---\nx');
        await setupTool();

        await expect(edit.handle({
            id: 'Memory/proj/n.md',
            edits: [{oldString: '', newString: 'y'}]
        }, EMPTY_CTX)).rejects.toThrow(/oldString is empty/);
    });

    it('rejects a no-op edit', async () => {
        await writeNote(vaultDir, 'Memory/proj/n.md', '---\ntitle: N\n---\nabc');
        await setupTool();

        await expect(edit.handle({
            id: 'Memory/proj/n.md',
            edits: [{oldString: 'abc', newString: 'abc'}]
        }, EMPTY_CTX)).rejects.toThrow(/no-op edit/);
    });

    it('rejects an empty edits array', async () => {
        await writeNote(vaultDir, 'Memory/proj/n.md', '---\ntitle: N\n---\nx');
        await setupTool();

        await expect(edit.handle({
            id: 'Memory/proj/n.md',
            edits: []
        }, EMPTY_CTX)).rejects.toThrow(/non-empty array/);
    });

    it('leaves frontmatter untouched', async () => {
        await writeNote(vaultDir, 'Memory/proj/n.md', '---\ntitle: Keep Me\ntags: [a, b]\n---\nbody-text');
        await setupTool();

        await edit.handle({
            id: 'Memory/proj/n.md',
            edits: [{oldString: 'body-text', newString: 'edited'}]
        }, EMPTY_CTX);

        const onDisk = await readFile(path.join(vaultDir, 'Memory/proj/n.md'), 'utf8');
        expect(onDisk).toContain('title: Keep Me');
        expect(onDisk).toContain('tags:');
        expect(onDisk).toContain('edited');
        expect(onDisk).not.toContain('body-text');
    });

    it('supports deleting text by passing empty newString', async () => {
        await writeNote(vaultDir, 'Memory/proj/n.md', '---\ntitle: N\n---\nkeep DROPME rest');
        await setupTool();

        const outcome = await edit.handle({
            id: 'Memory/proj/n.md',
            edits: [{oldString: ' DROPME', newString: ''}]
        }, EMPTY_CTX);

        const payload = JSON.parse(outcome.response.content[0]!.text);
        expect(payload.note.content.trimEnd()).toBe('keep rest');
    });

    it('is registered as a write-mode tool with pathArg=id', async () => {
        await setupTool();
        expect(edit.mode).toBe('write');
        expect(edit.pathArg).toBe('id');
    });

    it('emits a write event with the touched note id', async () => {
        await writeNote(vaultDir, 'Memory/proj/n.md', '---\ntitle: N\n---\nfoo');
        await setupTool();

        const outcome = await edit.handle({
            id: 'Memory/proj/n.md',
            edits: [{oldString: 'foo', newString: 'bar'}]
        }, EMPTY_CTX);

        expect(outcome.event?.kind).toBe('write');
        expect(outcome.event?.touched).toEqual(['Memory/proj/n.md']);
    });
});