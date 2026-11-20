import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, writeFile, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {ExternalNoteChange} from '@synaipse/core';
import {EntryStore, FilesystemNoteAdapter, Vault} from '@synaipse/vault';
import {SynaipseService} from '../src/Service.js';

/**
 * Server mode, plan A6: another process changed the shared store, the
 * adapter reports it through onExternalChange. The service must follow
 * with fulltext, graph and change listeners — without a file watcher.
 * A filesystem adapter with the hook attached stands in for MariaDB.
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

let dir: string;
let vault: Vault;
let service: SynaipseService;
let emit: (changes: ExternalNoteChange[]) => void;
let subscribers = 0;

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'synaipse-ext-'));
    await writeFile(path.join(dir, 'hub.md'), '---\ntitle: Hub\n---\nthe hub', 'utf8');
    vault = new Vault(dir);
    const notes = new FilesystemNoteAdapter(vault, new EntryStore(path.join(dir, '.synaipse', 'state.db')));
    const listeners = new Set<(c: readonly ExternalNoteChange[]) => void>();
    subscribers = 0;
    Object.assign(notes, {
        onExternalChange: (listener: (c: readonly ExternalNoteChange[]) => void) => {
            listeners.add(listener);
            subscribers++;
            return () => {
                listeners.delete(listener);
                subscribers--;
            };
        }
    });
    emit = (changes) => {
        for (const l of listeners) l(changes);
    };
    service = new SynaipseService(buildConfig(dir), {notes, skipWatcher: true, reranker: null});
    await service.start();
});

afterEach(async () => {
    await service.stop();
    await rm(dir, {recursive: true, force: true});
});

const settle = () => (service as unknown as {externalQueue: Promise<void>}).externalQueue;

describe('changes from another process (A6)', () => {
    it('subscribes without a watcher and unsubscribes on stop', async () => {
        expect(subscribers).toBe(1);
    });

    it('a foreign write reaches search, graph and change listeners', async () => {
        const events: string[] = [];
        service.onVaultChange((e) => events.push(`${e.kind}:${e.noteId}`));
        const before = service.graph();

        const abs = path.join(dir, 'remote.md');
        await writeFile(abs, '---\ntitle: Remote\n---\nzebrafinch links [[Hub]]', 'utf8');
        await vault.handleExternalChange(abs, 'created');
        emit([{kind: 'changed', note: vault.get('remote.md')}]);
        await settle();

        const hits = await service.search('zebrafinch', 'fulltext', 5);
        expect(hits.map((h) => h.noteId)).toContain('remote.md');
        const graph = service.graph();
        expect(graph).not.toBe(before);
        expect(graph.edges.some((e) => e.from === 'remote.md' && e.to === 'hub.md')).toBe(true);
        expect(events).toEqual(['updated:remote.md']);

        await unlink(abs);
        await vault.handleExternalChange(abs, 'deleted');
        emit([{kind: 'removed', id: 'remote.md'}]);
        await settle();
        expect((await service.search('zebrafinch', 'fulltext', 5)).map((h) => h.noteId)).not.toContain('remote.md');
        expect(service.graph().nodes.map((n) => n.id)).not.toContain('remote.md');
        expect(events).toEqual(['updated:remote.md', 'deleted:remote.md']);
    });

    it('a reset rebuilds the fulltext index from the reloaded adapter', async () => {
        const abs = path.join(dir, 'late.md');
        await writeFile(abs, 'quokkasaurus', 'utf8');
        await vault.handleExternalChange(abs, 'created');
        emit([{kind: 'reset'}]);
        await settle();
        expect((await service.search('quokkasaurus', 'fulltext', 5)).map((h) => h.noteId)).toContain('late.md');
    });
});
