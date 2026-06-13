import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, writeFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Vault} from '../src/Vault.js';

let vaultDir: string;

const author = {name: 'Test', email: 'test@local'};

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-history-'));
});

afterEach(async () => {
    await rm(vaultDir, {recursive: true, force: true});
});

describe('Vault autocommit via ngit', () => {
    it('does nothing when no history config is provided', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        await vault.write({path: 'foo.md', content: 'body'});

        await expect(access(path.join(vaultDir, '.ngit'))).rejects.toThrow();
        expect(await vault.getRepo()).toBeNull();
    });

    it('does nothing when autocommit is off', async () => {
        const vault = new Vault(vaultDir, {history: {autoCommit: false, author}});
        await vault.load();

        await vault.write({path: 'foo.md', content: 'body'});

        await expect(access(path.join(vaultDir, '.ngit'))).rejects.toThrow();
    });

    it('initialises .ngit lazily on the first write and commits the file', async () => {
        const vault = new Vault(vaultDir, {history: {autoCommit: true, author}});
        await vault.load();

        await vault.write({path: 'foo.md', content: 'first'}, {message: 'first version'});

        await access(path.join(vaultDir, '.ngit', 'HEAD'));

        const repo = await vault.getRepo();
        expect(repo).not.toBeNull();

        const log = await repo!.log({path: 'foo.md'});
        expect(log.length).toBe(1);
        expect(log[0]?.message.trim()).toBe('first version');
    });

    it('records subsequent writes as a chain of commits', async () => {
        const vault = new Vault(vaultDir, {history: {autoCommit: true, author}});
        await vault.load();

        await vault.write({path: 'foo.md', content: 'v1'}, {message: 'v1'});
        await vault.write({path: 'foo.md', content: 'v2'}, {message: 'v2'});
        await vault.write({path: 'foo.md', content: 'v3'}, {message: 'v3'});

        const repo = await vault.getRepo();
        const log = await repo!.log({path: 'foo.md'});

        expect(log.map((e) => e.message.trim())).toEqual(['v3', 'v2', 'v1']);
    });

    it('skips a commit when content is unchanged', async () => {
        const vault = new Vault(vaultDir, {history: {autoCommit: true, author}});
        await vault.load();

        await vault.write({path: 'foo.md', content: 'same'});
        await vault.write({path: 'foo.md', content: 'same'});

        const repo = await vault.getRepo();
        const log = await repo!.log({path: 'foo.md'});
        expect(log.length).toBe(1);
    });

    it('commits a delete', async () => {
        const vault = new Vault(vaultDir, {history: {autoCommit: true, author}});
        await vault.load();

        await vault.write({path: 'foo.md', content: 'hi'});
        await vault.delete('foo.md', {message: 'remove foo'});

        const repo = await vault.getRepo();
        const log = await repo!.log({});
        expect(log.length).toBe(2);
        expect(log[0]?.message.trim()).toBe('remove foo');
    });

    it('does not commit on external (watcher-driven) file changes', async () => {
        const vault = new Vault(vaultDir, {history: {autoCommit: true, author}});
        await vault.load();

        await vault.write({path: 'foo.md', content: 'initial'});

        await writeFile(path.join(vaultDir, 'foo.md'), 'external edit', 'utf8');
        await vault.handleExternalChange(path.join(vaultDir, 'foo.md'), 'updated');

        const repo = await vault.getRepo();
        const log = await repo!.log({path: 'foo.md'});
        expect(log.length).toBe(1);
    });

    it('getRepo returns null when history is configured but no commit has happened yet', async () => {
        const vault = new Vault(vaultDir, {history: {autoCommit: false, author}});
        await vault.load();
        expect(await vault.getRepo()).toBeNull();
    });
});