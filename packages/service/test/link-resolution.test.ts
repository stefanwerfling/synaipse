import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, writeFile, mkdir, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SynaipseService} from '../src/Service.js';

/**
 * B10: graph edges, backlinks and related() must resolve wikilinks the
 * same way (titles first, then aliases, first note wins), and an external
 * delete must drop the note from the cached graph.
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

const writeNote = async (root: string, relPath: string, body: string): Promise<void> => {
    const absolute = path.join(root, relPath);
    await mkdir(path.dirname(absolute), {recursive: true});
    await writeFile(absolute, body, 'utf8');
};

let vaultDir: string;
let service: SynaipseService;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-links-'));
    await writeNote(vaultDir, 'target.md', '---\ntitle: Target\naliases: [tgt]\n---\nbody');
    await writeNote(vaultDir, 'via-title.md', '---\ntitle: ViaTitle\n---\nsee [[Target]]');
    await writeNote(vaultDir, 'via-alias.md', '---\ntitle: ViaAlias\n---\nsee [[tgt]]');
    service = new SynaipseService(buildConfig(vaultDir), {skipWatcher: true, reranker: null});
    await service.start();
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('wikilink resolution is consistent', () => {
    it('graph() creates edges for alias links, matching backlinks', () => {
        const edges = service.graph().edges.filter((e) => e.to === 'target.md').map((e) => e.from).sort();
        expect(edges).toEqual(['via-alias.md', 'via-title.md']);
        expect(service.backlinks('target.md').sort()).toEqual(edges);
    });

    it('related() follows alias links too', async () => {
        const related = await service.related('via-alias.md');
        expect(related.map((r) => r.id)).toContain('target.md');
    });

    it('an external delete drops the note from the cached graph', async () => {
        expect(service.graph().nodes.map((n) => n.id)).toContain('via-alias.md');
        const abs = path.join(vaultDir, 'via-alias.md');
        await unlink(abs);
        await (service as unknown as {handleEvent: (k: string, p: string) => Promise<void>}).handleEvent('deleted', abs);
        expect(service.graph().nodes.map((n) => n.id)).not.toContain('via-alias.md');
        expect(service.graph().edges.some((e) => e.from === 'via-alias.md')).toBe(false);
    });
});
