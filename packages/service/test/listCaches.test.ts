import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Note} from '@synaipse/core';
import {EntryStore, FilesystemNoteAdapter, Vault} from '@synaipse/vault';
import {SynaipseService} from '../src/Service.js';

/**
 * Plan A1: list(), the tag postings, the todo snapshot and the session-log
 * reference lookup are cached per vault state. These tests pin that every
 * kind of change (service write, delete, external edit) is seen, and that
 * related() ranks exactly like the full scan it replaced.
 */

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

const put = async (root: string, rel: string, body: string): Promise<void> => {
    await mkdir(path.dirname(path.join(root, rel)), {recursive: true});
    await writeFile(path.join(root, rel), body, 'utf8');
};

let dir: string;
let running: SynaipseService | null;

const start = async (): Promise<SynaipseService> => {
    const started = new SynaipseService(buildConfig(dir), {skipWatcher: true, reranker: null});
    await started.start();
    running = started;
    return started;
};

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'synaipse-a1-'));
    running = null;
});

afterEach(async () => {
    await running?.stop();
    await rm(dir, {recursive: true, force: true});
});

describe('Vault.list cache', () => {
    it('hands out one frozen array between changes and a new one after each', async () => {
        await put(dir, 'a.md', '---\ntitle: A\n---\nsee [[B]]');
        await put(dir, 'b.md', '---\ntitle: B\n---\nb');
        const vault = new Vault(dir);
        await vault.load();
        const first = vault.list();
        expect(vault.list()).toBe(first);
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.isFrozen(first[0])).toBe(true);
        expect(() => (first as Note[]).sort()).toThrow();
        expect(first.find((n) => n.id === 'b.md')?.backlinks).toEqual(['a.md']);

        await vault.write({path: 'c.md', content: 'also [[B]]', frontmatter: {title: 'C'}});
        const second = vault.list();
        expect(second).not.toBe(first);
        expect(second.find((n) => n.id === 'b.md')?.backlinks.sort()).toEqual(['a.md', 'c.md']);

        await put(dir, 'a.md', '---\ntitle: A\n---\nno link any more');
        await vault.handleExternalChange(path.join(dir, 'a.md'), 'updated');
        const third = vault.list();
        expect(third).not.toBe(second);
        expect(third.find((n) => n.id === 'b.md')?.backlinks).toEqual(['c.md']);

        await vault.delete('c.md');
        expect(vault.list().map((n) => n.id).sort()).toEqual(['a.md', 'b.md']);
        expect(vault.list().find((n) => n.id === 'b.md')?.backlinks).toEqual([]);
    });
});

describe('todos cache', () => {
    it('follows writes, edits and deletes', async () => {
        await put(dir, 'p/one.md', '---\ntitle: One\n---\n- [ ] first\n- [x] done');
        await put(dir, 'q/two.md', '---\ntitle: Two\n---\n- [ ] second');
        const service = await start();
        expect(service.todos().map((t) => t.text)).toEqual(['first', 'second']);
        expect(service.todos('', true).map((t) => [t.text, t.done])).toEqual([['first', false], ['done', true], ['second', false]]);
        expect(service.todos('p/').map((t) => t.text)).toEqual(['first']);

        await service.writeNoteUnscoped({path: 'p/one.md', content: '- [x] first\n- [ ] new', frontmatter: {title: 'One renamed'}});
        expect(service.todos().map((t) => [t.title, t.text, t.line])).toEqual([['One renamed', 'new', 2], ['Two', 'second', 1]]);

        await service.deleteNoteUnscoped('q/two.md');
        expect(service.todos().map((t) => t.text)).toEqual(['new']);
    });
});

describe('related over the tag postings', () => {
    /** The full scan related() used before plan A1, minus semantics (no embeddings here). */
    const reference = (all: readonly Note[], id: string, limit: number) => {
        const note = all.find((n) => n.id === id)!;
        const acc = new Map<string, {score: number; reasons: Set<string>}>();
        const add = (other: string, w: number, reason: string): void => {
            if (other === id || w <= 0) return;
            const e = acc.get(other) ?? {score: 0, reasons: new Set<string>()};
            e.score += w;
            e.reasons.add(reason);
            acc.set(other, e);
        };
        const byTitle = new Map(all.map((n) => [n.title, n.id]));
        for (const link of note.wikilinks) {
            const target = byTitle.get(link);
            if (target !== undefined) add(target, 0.6, 'wikilink-out');
        }
        for (const b of note.backlinks) add(b, 0.6, 'wikilink-in');
        const mine = new Set(note.tags);
        for (const other of all) {
            if (other.id === id) continue;
            const shared = other.tags.filter((t) => mine.has(t));
            if (shared.length >= 2) add(other.id, shared.length * 0.25, `tags:${shared.join(',')}`);
            else if (shared.length === 1) add(other.id, 0.12, `tag:${shared[0]}`);
        }
        return [...acc.entries()]
            .map(([other, {score, reasons}]) => ({id: other, title: all.find((n) => n.id === other)!.title, score, reasons: [...reasons]}))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    };

    it('ranks, explains and breaks ties exactly like the full scan', async () => {
        const pool = ['a', 'b', 'c', 'd', 'e', 'f'];
        let seed = 7;
        const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
        for (let i = 0; i < 120; i++) {
            const tags = pool.filter(() => rnd() < 0.35);
            const links = [0, 1].map(() => `N${Math.floor(rnd() * 120)}`).map((t) => `[[${t}]]`).join(' ');
            await put(dir, `n/${String(i).padStart(3, '0')}.md`, `---\ntitle: N${i}\ntags: [${tags.join(', ')}]\n---\n${links}`);
        }
        const service = await start();
        const all = service.listNotes();
        for (const note of all.filter((_, i) => i % 7 === 0)) {
            expect(await service.related(note.id, 12), note.id).toEqual(reference(all, note.id, 12));
        }

        // After a tag change the postings follow.
        await service.writeNoteUnscoped({path: 'n/000.md', content: '', frontmatter: {title: 'N0', tags: ['zzz']}});
        await service.writeNoteUnscoped({path: 'n/001.md', content: '', frontmatter: {title: 'N1', tags: ['zzz']}});
        const related = await service.related('n/000.md', 5);
        expect(related.map((r) => [r.id, r.reasons])).toContainEqual(['n/001.md', ['tag:zzz']]);
    });
});

describe('session log references', () => {
    it('resolve like the written [[link]]: a title wins over an earlier alias', async () => {
        await put(dir, 'Memory/p/a.md', '---\ntitle: Alpha\naliases: [Target]\n---\na');
        await put(dir, 'Memory/p/b.md', '---\ntitle: Target\n---\nb');
        const service = await start();
        await service.appendSessionLog('worked', ['Target', 'Alpha', 'Nobody'], {project: 'p'});
        const counts = Object.fromEntries(service.staleNotes({olderThanDays: 0})
            .filter((s) => s.id === 'Memory/p/a.md' || s.id === 'Memory/p/b.md')
            .map((s) => [s.id, s.referencedCount]));
        expect(counts).toEqual({'Memory/p/a.md': 1, 'Memory/p/b.md': 1});
    });
});

describe('link resolution through the adapter index', () => {
    const edgesFrom = (service: SynaipseService, id: string): string[] =>
        service.graph().edges.filter((e) => e.kind === 'wikilink' && e.from === id).map((e) => e.to);

    it('graph edges and backlinks agree on a duplicate title after a retitle', async () => {
        await put(dir, 'x.md', '---\ntitle: X\n---\nx');
        await put(dir, 'y.md', '---\ntitle: T\n---\ny');
        await put(dir, 'z.md', '---\ntitle: Z\n---\nsee [[T]]');
        const service = await start();
        await service.writeNoteUnscoped({path: 'x.md', content: 'x', frontmatter: {title: 'T'}});
        // The link index keeps y first (it held "T" before x); the edge must follow it.
        expect(service.backlinks('y.md')).toEqual(['z.md']);
        expect(service.backlinks('x.md')).toEqual([]);
        expect(edgesFrom(service, 'z.md')).toEqual(['y.md']);
    });

    it('an adapter without resolveLink still resolves through the list-built map', async () => {
        await put(dir, 'a.md', '---\ntitle: A\naliases: [Alpha]\n---\na');
        await put(dir, 'b.md', '---\ntitle: B\n---\n[[A]] and [[Alpha]] and [[Ghost]]');
        const vault = new Vault(dir);
        const notes = new FilesystemNoteAdapter(vault, new EntryStore(path.join(dir, '.synaipse', 'state.db')));
        Object.assign(notes, {resolveLink: undefined});
        const service = new SynaipseService(buildConfig(dir), {notes, skipWatcher: true, reranker: null});
        await service.start();
        running = service;
        expect(edgesFrom(service, 'b.md')).toEqual(['a.md', 'a.md']);
        const written = await service.writeNoteUnscoped({path: 'c.md', content: '[[B]] [[Nope]]', frontmatter: {title: 'C'}});
        expect(service.unresolvedWikilinks(written)).toEqual(['Nope']);
    });
});
