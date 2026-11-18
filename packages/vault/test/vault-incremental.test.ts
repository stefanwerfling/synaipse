import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, writeFile, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Vault} from '../src/Vault.js';

/**
 * Plan P1 / A1: backlinks and tags are maintained incrementally. After any
 * sequence of mutations the vault must agree with a freshly loaded one.
 */

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'synaipse-vault-inc-'));
});

afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
});

const snapshot = (vault: Vault) => ({
    backlinks: Object.fromEntries(vault.list().map((n) => [n.id, [...n.backlinks].sort()]).sort()),
    tags: Object.fromEntries([...vault.tags()].map(([t, ids]) => [t, [...ids].sort()]).sort())
});

const fresh = async (): Promise<ReturnType<typeof snapshot>> => {
    const v = new Vault(dir);
    await v.load();
    return snapshot(v);
};

describe('Vault incremental indexes', () => {
    it('stays equal to a full reload across writes, retags, alias changes and deletes', async () => {
        const vault = new Vault(dir);
        await vault.load();

        await vault.write({path: 'a.md', content: 'see [[B]] and [[Bee]]', frontmatter: {title: 'A', tags: ['x']}});
        await vault.write({path: 'b.md', content: 'back to [[A]]', frontmatter: {title: 'B', tags: ['x', 'y']}});
        expect(vault.get('b.md').backlinks).toEqual(['a.md']);
        expect(snapshot(vault)).toEqual(await fresh());

        // alias added later → [[Bee]] now also resolves to b (still one backlink)
        await vault.write({path: 'b.md', content: 'back to [[A]]', frontmatter: {title: 'B', aliases: ['Bee'], tags: ['y']}});
        expect(vault.backlinksOf('b.md')).toEqual(['a.md']);
        expect(vault.tags().get('x')).toEqual(['a.md']);
        expect(snapshot(vault)).toEqual(await fresh());

        // a note that only links via the alias
        await vault.write({path: 'c.md', content: '[[Bee]]', frontmatter: {title: 'C'}});
        expect(vault.backlinksOf('b.md').sort()).toEqual(['a.md', 'c.md']);

        await vault.delete('a.md');
        expect(vault.backlinksOf('b.md')).toEqual(['c.md']);
        expect(vault.tags().has('x')).toBe(false);
        expect(snapshot(vault)).toEqual(await fresh());
    });

    it('applies external changes from the watcher', async () => {
        const vault = new Vault(dir);
        await vault.load();
        await vault.write({path: 't.md', content: 'target', frontmatter: {title: 'T'}});

        const ext = path.join(dir, 'ext.md');
        await writeFile(ext, '---\ntitle: Ext\ntags: [e]\n---\n[[T]]', 'utf8');
        await vault.handleExternalChange(ext, 'created');
        expect(vault.backlinksOf('t.md')).toEqual(['ext.md']);
        expect(vault.tags().get('e')).toEqual(['ext.md']);

        await unlink(ext);
        await vault.handleExternalChange(ext, 'deleted');
        expect(vault.backlinksOf('t.md')).toEqual([]);
        expect(snapshot(vault)).toEqual(await fresh());
    });

    it('returns backlink arrays the caller cannot use to corrupt the index', async () => {
        const vault = new Vault(dir);
        await vault.load();
        await vault.write({path: 't.md', content: 'x', frontmatter: {title: 'T'}});
        await vault.write({path: 'l.md', content: '[[T]]', frontmatter: {title: 'L'}});
        vault.get('t.md').backlinks.push('bogus.md');
        expect(vault.get('t.md').backlinks).toEqual(['l.md']);
    });
});
