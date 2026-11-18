import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, writeFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EntryStore} from '../src/EntryStore.js';

/** Plan P1 / A2: index entries in the SQLite state DB. */

let dir: string;
let dbFile: string;
const open: EntryStore[] = [];

const store = (opts: ConstructorParameters<typeof EntryStore>[1] = {}): EntryStore => {
    const s = new EntryStore(dbFile, {debounceMs: 0, ...opts});
    open.push(s);
    return s;
};

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'synaipse-state-'));
    dbFile = path.join(dir, '.synaipse', 'state.db');
});

afterEach(async () => {
    for (const s of open.splice(0)) s.close();
    await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 20});
});

describe('EntryStore', () => {
    it('persists entries, embedding state and the access journal across instances', async () => {
        const a = store();
        await a.load();
        a.set('n.md', {hash: 'h1', mtime: 1});
        a.setEmbedded('n.md', 'h1', 'voyage:m:3');
        a.touch('n.md', undefined, 1000);
        a.touchReference('n.md', undefined, 2000);
        a.set('n.md', {hash: 'h2', mtime: 2});
        await a.flush();
        a.close();

        const b = store();
        await b.load();
        expect(b.get('n.md')).toEqual({
            hash: 'h2', mtime: 2, embeddedHash: 'h1', embedModel: 'voyage:m:3',
            accessCount: 1, lastAccessed: 1000, referencedCount: 1, lastReferenced: 2000
        });
    });

    it('new entries are explicitly not embedded', async () => {
        const a = store();
        await a.load();
        a.set('n.md', {hash: 'h', mtime: 1});
        expect(a.get('n.md')?.embeddedHash).toBe('');
    });

    it('persists deletes', async () => {
        const a = store();
        await a.load();
        a.set('x.md', {hash: 'h', mtime: 1});
        await a.flush();
        a.delete('x.md');
        await a.flush();
        a.close();

        const b = store();
        await b.load();
        expect(b.has('x.md')).toBe(false);
    });

    it('notices writes from a parallel connection (e.g. a CLI process)', async () => {
        const server = store();
        await server.load();
        server.set('mine.md', {hash: 'm', mtime: 1});

        const cli = store();
        await cli.load();
        cli.set('cli.md', {hash: 'c', mtime: 1});
        await cli.flush();

        expect(await server.reloadIfChanged()).toBe(true);
        expect(server.get('cli.md')?.hash).toBe('c');
        // its own unflushed change survives the reload
        expect(server.get('mine.md')?.hash).toBe('m');
        expect(await server.reloadIfChanged()).toBe(false);
    });

    it('imports the legacy JSON cache once, adopting entries as embedded, and keeps the file', async () => {
        const json = path.join(dir, '.synaipse-index.json');
        await writeFile(json, JSON.stringify({'a.md': {hash: 'h', mtime: 5, accessCount: 3}}), 'utf8');

        const a = store({legacyJsonPath: json});
        await a.load();
        expect(a.get('a.md')).toMatchObject({hash: 'h', accessCount: 3, embeddedHash: 'h', embedModel: 'legacy'});
        const files = await readdir(dir);
        expect(files).not.toContain('.synaipse-index.json');
        expect(files.some((f) => f.startsWith('.synaipse-index.json.migrated-'))).toBe(true);

        // a JSON file that reappears later is not imported over existing state
        await writeFile(json, JSON.stringify({'b.md': {hash: 'x', mtime: 1}}), 'utf8');
        a.close();
        const b = store({legacyJsonPath: json});
        await b.load();
        expect(b.has('b.md')).toBe(false);
    });

    it('with renameLegacy=false imports but leaves the file untouched', async () => {
        const json = path.join(dir, 'other-vault-index.json');
        await writeFile(json, JSON.stringify({'a.md': {hash: 'h', mtime: 5}}), 'utf8');
        const a = store({legacyJsonPath: json, renameLegacy: false});
        await a.load();
        expect(a.get('a.md')?.hash).toBe('h');
        expect(await readdir(dir)).toContain('other-vault-index.json');
    });

    it('survives a corrupt legacy JSON (backed up, nothing imported)', async () => {
        const json = path.join(dir, '.synaipse-index.json');
        await writeFile(json, '{"a.md": {"hash": ', 'utf8');
        const a = store({legacyJsonPath: json});
        await a.load();
        expect(a.size()).toBe(0);
        expect((await readdir(dir)).some((f) => f.includes('.corrupt-'))).toBe(true);
    });
});
