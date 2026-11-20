import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Note, NoteAdapter, NoteWriteInput} from '@synaipse/core';
import {RepoHistory, toMarkdownFile} from '../src/RepoHistory.js';
import {VersionedNoteAdapter, withServerHistory} from '../src/VersionedNoteAdapter.js';
import {runWriteBatch} from '../src/WriteBatch.js';

/** Minimal in-memory store standing in for MariaDB. */
const memoryStore = (): NoteAdapter => {
    const notes = new Map<string, Note>();
    const note = (input: NoteWriteInput): Note => ({
        id: input.path, path: input.path, title: input.path, content: input.content,
        frontmatter: input.frontmatter ?? {}, tags: [], wikilinks: [], backlinks: [], mtime: Date.now(), hash: 'h'
    });
    return {
        load: async () => undefined,
        isLoaded: () => true,
        list: () => [...notes.values()],
        get: (id) => notes.get(id)!,
        tryGet: (id) => notes.get(id),
        read: async (id) => notes.get(id)!,
        write: async (input) => {
            const n = note(input);
            notes.set(n.id, n);
            return n;
        },
        delete: async (id) => {
            notes.delete(id);
        },
        backlinksOf: () => [],
        tags: () => new Map(),
        getEntry: () => undefined,
        entryIds: () => [],
        recordEntry: () => undefined,
        recordEmbedded: () => undefined,
        recordAccess: () => undefined,
        recordReference: () => undefined,
        removeEntry: () => undefined,
        flushEntries: async () => undefined,
        syncEntries: async () => false
    };
};

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'synaipse-repohist-'));
});

afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
});

describe('server-mode history (A6)', () => {
    it('commits each write as the markdown file and each delete', async () => {
        const history = new RepoHistory(dir);
        const notes = new VersionedNoteAdapter(memoryStore(), history);

        await notes.write({path: 'a.md', content: 'body', frontmatter: {title: 'A'}}, {message: 'first', author: {name: 'Ann', email: 'ann@x'}});
        await notes.write({path: 'a.md', content: 'body 2'});
        await notes.delete('a.md');

        const repo = (await history.getRepo())!;
        const log = await repo.log({path: 'a.md'});
        expect(log.map((e) => e.message.trim())).toEqual(['synaipse: delete a.md', 'synaipse: write a.md', 'first']);
        expect(log[2]?.author.name).toBe('Ann');
        expect((await repo.show(log[2]!.sha, 'a.md')).toString('utf8')).toBe(toMarkdownFile('body', {title: 'A'}));
        expect((await repo.show(log[1]!.sha, 'a.md')).toString('utf8')).toBe('body 2');
    });

    it('a batch becomes one commit; a note created and deleted inside it is left out', async () => {
        const history = new RepoHistory(dir);
        const notes = new VersionedNoteAdapter(memoryStore(), history);

        await runWriteBatch(async () => {
            await notes.write({path: 'x.md', content: 'x'});
            await notes.write({path: 'y.md', content: 'y'});
            await notes.write({path: 'tmp.md', content: 't'});
            await notes.delete('tmp.md');
        }, (batch) => notes.commitBatch(batch, {message: 'import'}));

        const repo = (await history.getRepo())!;
        const log = await repo.log();
        expect(log).toHaveLength(1);
        expect(log[0]?.message.trim()).toBe('import');
        expect((await repo.listAtCommit(log[0]!.sha)).map((e) => e.name).sort()).toEqual(['x.md', 'y.md']);
    });

    it('deleting a note that was never committed is not an error', async () => {
        const history = new RepoHistory(dir);
        expect(await history.commit({adds: [], deletes: ['ghost.md'], message: 'm'})).toBeNull();
        await history.commit({adds: [{path: 'a.md', content: 'a'}], deletes: [], message: 'm'});
        expect(await history.commit({adds: [], deletes: ['ghost.md'], message: 'm'})).toBeNull();
    });

    it('two processes sharing the directory lose no commit', async () => {
        const a = new RepoHistory(dir);
        const b = new RepoHistory(dir);
        await a.commit({adds: [{path: 'seed.md', content: 's'}], deletes: [], message: 'seed'});
        await Promise.all(Array.from({length: 12}, (_, i) =>
            (i % 2 === 0 ? a : b).commit({adds: [{path: `n${i}.md`, content: String(i)}], deletes: [], message: `n${i}`})));

        const repo = (await a.getRepo())!;
        const head = (await repo.head())!;
        expect((await repo.listAtCommit(head)).map((e) => e.name)).toHaveLength(13);
        expect(await repo.log()).toHaveLength(13);
    });

    it('without a directory the store stays unversioned', () => {
        const store = memoryStore();
        expect(withServerHistory(store, undefined)).toEqual({notes: store, history: null});
        expect(withServerHistory(store, '/tmp/h').notes).toBeInstanceOf(VersionedNoteAdapter);
    });
});
