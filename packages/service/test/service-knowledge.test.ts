import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SynaipseService} from '../src/Service.js';

/** Plan P8 / B4 S2: superseded, expired and low-confidence notes in search and prime. */

let vaultDir: string;
let service: SynaipseService;

const config = (vaultPath: string) => ({
    vaultPath,
    indexCachePath: path.join(vaultPath, '.cache.json'),
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    auditLogPath: path.join(vaultPath, '.audit.jsonl'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://127.0.0.1:9', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0},
    project: {name: 'demo'}
});

const put = async (rel: string, text: string): Promise<void> => {
    const abs = path.join(vaultDir, rel);
    await mkdir(path.dirname(abs), {recursive: true});
    await writeFile(abs, text, 'utf8');
};

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-knowledge-'));
    await put('Memory/demo/decisions/cache-redis.md', '---\ntitle: Cache in Redis\n---\nThe cache lives in Redis with a 24 h TTL. Redis cache Redis cache.');
    await put('Memory/demo/decisions/cache-memory.md', '---\ntitle: In-process cache\nsupersedes: ["Cache in Redis"]\n---\nThe cache is an in-process LRU now.');
    await put('Memory/demo/notes/hotline.md', '---\ntitle: Hotline\nvalid_until: 2020-01-01\n---\nThe hotline number is 123.');
    await put('Memory/demo/notes/hotline-new.md', '---\ntitle: Hotline rotation\n---\nThe hotline goes to the on-call rotation.');
    await put('Other/cache-v3.md', '---\ntitle: Cache v3\nsupersedes: ["Memory/demo/decisions/cache-memory.md"]\n---\nOutside the demo folder.');
    service = new SynaipseService(config(vaultDir));
    await service.start();
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('knowledge state in search', () => {
    it('ranks the successor first when only the superseded note matches, and marks the old hit', async () => {
        const hits = await service.search('Redis 24 h TTL', 'hybrid', 5);
        const ids = hits.map((h) => h.noteId);

        // The chain ends at Other/cache-v3.md (path reference in frontmatter).
        expect(ids[0]).toBe('Other/cache-v3.md');
        expect(ids.indexOf('Memory/demo/decisions/cache-redis.md')).toBeGreaterThan(0);
        expect(hits.find((h) => h.noteId === 'Memory/demo/decisions/cache-redis.md')).toMatchObject({supersededBy: 'Other/cache-v3.md'});
    });

    it('does not pull in or name a successor outside the search scope', async () => {
        const hits = await service.search('Redis 24 h TTL', 'hybrid', 5, {include: ['Memory/demo/']});

        expect(hits.map((h) => h.noteId)).not.toContain('Other/cache-v3.md');
        expect(JSON.stringify(hits)).not.toContain('cache-v3');
    });

    it('marks and demotes expired notes', async () => {
        const hits = await service.search('hotline', 'hybrid', 5);

        expect(hits[0]?.noteId).toBe('Memory/demo/notes/hotline-new.md');
        expect(hits.find((h) => h.noteId === 'Memory/demo/notes/hotline.md')).toMatchObject({expired: true});
    });

    it('follows a new supersedes after a write', async () => {
        await service.writeNote({path: 'Memory/demo/notes/hotline-v2.md', content: 'Hotline v2', frontmatter: {title: 'Hotline v2', supersedes: ['Hotline rotation']}});

        expect(service.knowledgeState('Memory/demo/notes/hotline-new.md')).toMatchObject({supersededBy: 'Memory/demo/notes/hotline-v2.md'});
    });
});

describe('knowledge state in prime', () => {
    it('leaves superseded and expired notes out of the primer', async () => {
        const primer = await service.prime({project: 'demo', limit: 50});
        const ids = primer.context.map((e) => e.id);

        expect(ids).toContain('Memory/demo/notes/hotline-new.md');
        expect(ids).not.toContain('Memory/demo/decisions/cache-redis.md');
        expect(ids).not.toContain('Memory/demo/decisions/cache-memory.md');
        expect(ids).not.toContain('Memory/demo/notes/hotline.md');
    });
});
