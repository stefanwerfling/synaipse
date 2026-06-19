import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SynaipseService} from '../src/Service.js';

const buildConfig = (vaultPath: string, indexCachePath: string, project?: string) => ({
    vaultPath,
    indexCachePath,
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://localhost:6333', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0},
    ...(project !== undefined ? {project: {name: project}} : {})
});

const PNG_BYTES = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
]);
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', 'utf8');

let vaultDir: string;
let cacheFile: string;
let service: SynaipseService;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-asset-'));
    cacheFile = path.join(vaultDir, '.cache.json');
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('SynaipseService.writeAssetScoped', () => {
    it('writes inside the project _assets folder with a relativePath when noteId is given', async () => {
        service = new SynaipseService(buildConfig(vaultDir, cacheFile, 'proj'));
        await service.start();

        const result = await service.writeAssetScoped({
            content: PNG_BYTES,
            contentType: 'image/png',
            noteId: 'Memory/proj/decisions/auth.md'
        });

        expect(result.assetId).toMatch(/^Memory\/proj\/_assets\/img-[a-f0-9]{12}\.png$/);
        expect(result.relativePath).toBe(`../_assets/${path.basename(result.assetId)}`);
        expect(result.deduped).toBe(false);
        expect(result.written).toBe(PNG_BYTES.length);

        const onDisk = await readFile(path.join(vaultDir, result.assetId));
        expect(onDisk.equals(PNG_BYTES)).toBe(true);
    });

    it('rejects a noteId outside the active project scope', async () => {
        service = new SynaipseService(buildConfig(vaultDir, cacheFile, 'proj'));
        await service.start();

        await expect(service.writeAssetScoped({
            content: PNG_BYTES,
            contentType: 'image/png',
            noteId: 'Memory/other/foo.md'
        })).rejects.toThrow(/outside project scope/);
    });

    it('still routes to project _assets when noteId is omitted, but skips relativePath', async () => {
        service = new SynaipseService(buildConfig(vaultDir, cacheFile, 'proj'));
        await service.start();

        const result = await service.writeAssetScoped({
            content: SVG_BYTES,
            contentType: 'image/svg+xml'
        });

        expect(result.assetId).toMatch(/^Memory\/proj\/_assets\/img-[a-f0-9]{12}\.svg$/);
        expect(result.relativePath).toBeUndefined();
        expect(result.deduped).toBe(false);
    });

    it('refuses when no project scope is active anywhere', async () => {
        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        await expect(service.writeAssetScoped({
            content: PNG_BYTES,
            contentType: 'image/png',
            noteId: 'Memory/x/y.md'
        })).rejects.toThrow();
    });

    it('dedupes identical bytes — second write returns deduped=true, written=0, same assetId', async () => {
        service = new SynaipseService(buildConfig(vaultDir, cacheFile, 'proj'));
        await service.start();

        const a = await service.writeAssetScoped({
            content: PNG_BYTES,
            contentType: 'image/png',
            noteId: 'Memory/proj/note-a.md'
        });
        const b = await service.writeAssetScoped({
            content: PNG_BYTES,
            contentType: 'image/png',
            noteId: 'Memory/proj/sub/note-b.md'
        });

        expect(b.assetId).toBe(a.assetId);
        expect(b.deduped).toBe(true);
        expect(b.written).toBe(0);
        // relativePath is recomputed against the new note's depth
        expect(b.relativePath).toBe(`../_assets/${path.basename(a.assetId)}`);

        const fileStat = await stat(path.join(vaultDir, a.assetId));
        expect(fileStat.size).toBe(PNG_BYTES.length);
    });

    it('honours an explicit project override in ProjectOpts', async () => {
        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const result = await service.writeAssetScoped(
            {content: PNG_BYTES, contentType: 'image/png', noteId: 'Memory/override/x.md'},
            {project: 'override'}
        );

        expect(result.assetId).toMatch(/^Memory\/override\/_assets\/img-[a-f0-9]{12}\.png$/);
    });
});