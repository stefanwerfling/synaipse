import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WriteConflictError} from '@synaipse/core';
import {SynaipseService} from '../src/Service.js';

/** Plan P8 / B4 S3: write modes, optimistic lock and the duplicate check. */

let vaultDir: string;
let service: SynaipseService;
const P = {project: 'demo'};

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-guard-'));
    service = new SynaipseService({
        vaultPath: vaultDir,
        indexCachePath: path.join(vaultDir, '.cache.json'),
        chatStoreDir: path.join(vaultDir, '..', 'chats'),
        auditLogPath: path.join(vaultDir, '.audit.jsonl'),
        embeddings: {provider: 'none' as const},
        qdrant: {url: 'http://127.0.0.1:9', collection: 'test'},
        server: {name: 'synaipse-test', version: '0.0.0'},
        web: {port: 0}
    });
    await service.start();
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('write guards', () => {
    it('create fails on an existing note, overwrite on a missing one, upsert never', async () => {
        await expect(service.writeNote({path: 'a.md', content: 'x', mode: 'overwrite'}, P)).rejects.toBeInstanceOf(WriteConflictError);
        const first = await service.writeNote({path: 'a.md', content: 'x', mode: 'create'}, P);

        const conflict = await service.writeNote({path: 'a.md', content: 'y', mode: 'create'}, P).catch((e: unknown) => e);
        expect(conflict).toBeInstanceOf(WriteConflictError);
        expect(conflict).toMatchObject({noteId: 'Memory/demo/a.md', currentHash: first.hash});

        await service.writeNote({path: 'a.md', content: 'y', mode: 'overwrite'}, P);
        await service.writeNote({path: 'a.md', content: 'z'}, P);
        expect(service.readNote('Memory/demo/a.md').content).toContain('z');
    });

    it('expectedHash rejects a stale write and leaves the note alone', async () => {
        const v1 = await service.writeNote({path: 'b.md', content: 'one'}, P);
        await service.writeNote({path: 'b.md', content: 'two', expectedHash: v1.hash}, P);

        await expect(service.writeNote({path: 'b.md', content: 'three', expectedHash: v1.hash}, P)).rejects.toThrow(/changed since you read it/);
        await expect(service.updateNote('Memory/demo/b.md', {content: 'four', expectedHash: v1.hash}, P)).rejects.toBeInstanceOf(WriteConflictError);
        expect(service.readNote('Memory/demo/b.md').content).toContain('two');
    });

    it('lets only one of two concurrent writers with the same expectedHash through', async () => {
        const v1 = await service.writeNote({path: 'c.md', content: 'base'}, P);
        const results = await Promise.allSettled([
            service.writeNote({path: 'c.md', content: 'left', expectedHash: v1.hash}, P),
            service.writeNote({path: 'c.md', content: 'right', expectedHash: v1.hash}, P)
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });
});

describe('possibleDuplicates', () => {
    it('names an existing note with the same knowledge and ignores excluded ids', async () => {
        await service.writeNote({path: 'cache.md', content: 'The cache lives in Redis with a 24 hour TTL and LRU eviction.', frontmatter: {title: 'Cache in Redis'}}, P);
        await service.writeNote({path: 'deploy.md', content: 'Images are built in CI and deployed on Tuesdays.', frontmatter: {title: 'Deploy pipeline'}}, P);

        const dups = await service.possibleDuplicates({title: 'Redis cache', content: 'Our cache lives in Redis, 24 hour TTL, LRU eviction.'});
        expect(dups.map((d) => d.id)).toEqual(['Memory/demo/cache.md']);
        expect(await service.possibleDuplicates({title: 'Redis cache', content: 'Our cache lives in Redis, 24 hour TTL, LRU eviction.'}, ['Memory/demo/cache.md'])).toEqual([]);
    });
});
