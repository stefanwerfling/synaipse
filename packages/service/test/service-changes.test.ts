import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SynaipseService} from '../src/Service.js';

/** Plan P8 S4: search filters, removed notes, inbox candidates. */

let vaultDir: string;
let service: SynaipseService;
const P = {project: 'demo'};

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-changes-'));
    service = new SynaipseService({
        vaultPath: vaultDir,
        indexCachePath: path.join(vaultDir, '.cache.json'),
        chatStoreDir: path.join(vaultDir, '..', 'chats'),
        auditLogPath: path.join(vaultDir, '.audit.jsonl'),
        schedulesPath: path.join(vaultDir, '..', 'schedules.json'),
        embeddings: {provider: 'none' as const},
        qdrant: {url: 'http://127.0.0.1:9', collection: 'test'},
        server: {name: 'synaipse-test', version: '0.0.0'},
        web: {port: 0},
        project: {name: 'demo'},
        git: {autoCommit: true, author: {name: 'T', email: 't@local'}}
    });
    await service.start();
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('search filters', () => {
    it('keeps only notes with all tags and modified since', async () => {
        await service.writeNote({path: 'a.md', content: 'cache notes alpha', frontmatter: {title: 'A', tags: ['cache', 'redis']}}, P);
        await service.writeNote({path: 'b.md', content: 'cache notes beta', frontmatter: {title: 'B', tags: ['cache']}}, P);

        expect((await service.search('cache notes', 'hybrid', 10, undefined, {tags: ['cache', '#redis']})).map((h) => h.noteId)).toEqual(['Memory/demo/a.md']);
        expect(await service.search('cache notes', 'hybrid', 10, undefined, {sinceMs: Date.now() + 60_000})).toEqual([]);
        expect((await service.search('cache notes', 'hybrid', 10, undefined, {sinceMs: Date.now() - 60_000})).length).toBe(2);
    });
});

describe('removedSince', () => {
    it('lists deleted notes that are still gone, newest first, from the history', async () => {
        const start = Date.now() - 1000;
        await service.writeNote({path: 'gone.md', content: 'x'}, P);
        await service.writeNote({path: 'back.md', content: 'x'}, P);
        await service.deleteNote('Memory/demo/gone.md', P);
        await service.deleteNote('Memory/demo/back.md', P);
        await service.writeNote({path: 'back.md', content: 'again'}, P);

        const removed = await service.removedSince(start);
        expect(removed.map((r) => [r.id, r.how])).toEqual([['Memory/demo/gone.md', 'deleted']]);
        expect(await service.removedSince(Date.now() + 60_000)).toEqual([]);
    });
});

describe('inboxCandidates', () => {
    it('names notes that already hold an entry and curated targets for the rest', async () => {
        await service.writeNote({path: 'decisions/cache.md', content: 'The cache lives in Redis with a 24 hour TTL and LRU eviction.', frontmatter: {title: 'Cache in Redis'}}, P);
        await service.writeNote({path: 'howto/deploy.md', content: 'Deploys run on Tuesdays through the pipeline; approve the production stage.', frontmatter: {title: 'Deploy process'}}, P);
        await service.appendInboxEntry('Cache lives in Redis with a 24 hour TTL.', ['cache'], P);
        await service.appendInboxEntry('Deploys need a second approver for the production stage.', [], P);

        const candidates = await service.inboxCandidates('demo');
        const byText = new Map(candidates.map((c) => [c.text, c]));

        expect(candidates).toHaveLength(2);
        expect(byText.get('Cache lives in Redis with a 24 hour TTL.')?.alreadyIn.map((d) => d.id)).toEqual(['Memory/demo/decisions/cache.md']);
        expect(byText.get('Cache lives in Redis with a 24 hour TTL.')?.tags).toEqual(['cache']);

        const deploy = byText.get('Deploys need a second approver for the production stage.');
        expect(deploy?.alreadyIn).toEqual([]);
        expect(deploy?.targets[0]?.id).toBe('Memory/demo/howto/deploy.md');
        expect(candidates.every((c) => c.targets.every((t) => !t.id.includes('/inbox/')))).toBe(true);
    });
});
