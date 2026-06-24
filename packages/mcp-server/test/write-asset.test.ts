import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SynaipseService} from '@synaipse/service';
import {buildTools, EMPTY_CTX} from '../src/Tools.js';

const buildConfig = (vaultPath: string, indexCachePath: string, project = 'proj') => ({
    vaultPath,
    indexCachePath,
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    auditLogPath: path.join(vaultPath, '.audit.jsonl'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://localhost:6333', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0},
    project: {name: project}
});

const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
]);

let vaultDir: string;
let service: SynaipseService;
let writeAsset: ReturnType<typeof buildTools>[number];

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-tool-asset-'));
    service = new SynaipseService(buildConfig(vaultDir, path.join(vaultDir, '.cache.json')));
    await service.start();
    const tool = buildTools(service).find((t) => t.definition.name === 'synaipse_write_asset');
    if (tool === undefined) throw new Error('synaipse_write_asset tool not registered');
    writeAsset = tool;
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
    delete process.env.SYNAIPSE_ASSET_MAX_BYTES;
});

describe('synaipse_write_asset tool', () => {
    it('accepts a valid base64 PNG and returns assetId + relativePath', async () => {
        const outcome = await writeAsset.handle({
            data: PNG.toString('base64'),
            contentType: 'image/png',
            noteId: 'Memory/proj/a/b.md'
        }, EMPTY_CTX);

        expect(outcome.response.isError).toBeFalsy();
        const payload = JSON.parse(outcome.response.content[0]!.text);
        expect(payload.asset.assetId).toMatch(/^Memory\/proj\/_assets\/img-[a-f0-9]{12}\.png$/);
        expect(payload.asset.relativePath).toBe(`../_assets/${path.basename(payload.asset.assetId)}`);
        expect(payload.asset.deduped).toBe(false);
        expect(outcome.event?.kind).toBe('write');
        expect(outcome.event?.touched[0]).toBe(payload.asset.assetId);
    });

    it('rejects an unsupported content type before touching the filesystem', async () => {
        const spy = vi.spyOn(service, 'writeAssetScoped');

        await expect(writeAsset.handle({
            data: PNG.toString('base64'),
            contentType: 'application/pdf',
            noteId: 'Memory/proj/a.md'
        }, EMPTY_CTX)).rejects.toThrow(/not an allowed asset MIME/);

        expect(spy).not.toHaveBeenCalled();
    });

    it('rejects malformed base64 with a clear message', async () => {
        await expect(writeAsset.handle({
            data: '!!!not-base64!!!',
            contentType: 'image/png',
            noteId: 'Memory/proj/a.md'
        }, EMPTY_CTX)).rejects.toThrow(/not valid base64/);
    });

    it('rejects empty data', async () => {
        await expect(writeAsset.handle({
            data: '',
            contentType: 'image/png',
            noteId: 'Memory/proj/a.md'
        }, EMPTY_CTX)).rejects.toThrow(/empty/);
    });

    it('enforces SYNAIPSE_ASSET_MAX_BYTES', async () => {
        process.env.SYNAIPSE_ASSET_MAX_BYTES = '8';

        await expect(writeAsset.handle({
            data: PNG.toString('base64'),  // 16 bytes
            contentType: 'image/png',
            noteId: 'Memory/proj/a.md'
        }, EMPTY_CTX)).rejects.toThrow(/exceeds limit 8/);
    });

    it('omits noteId → asset still lands in project _assets, no relativePath', async () => {
        const outcome = await writeAsset.handle({
            data: PNG.toString('base64'),
            contentType: 'image/png'
        }, EMPTY_CTX);

        const payload = JSON.parse(outcome.response.content[0]!.text);
        expect(payload.asset.assetId).toMatch(/^Memory\/proj\/_assets\//);
        expect(payload.asset.relativePath).toBeUndefined();
    });

    it('refuses noteId outside the project (defence in depth — service throws)', async () => {
        await expect(writeAsset.handle({
            data: PNG.toString('base64'),
            contentType: 'image/png',
            noteId: 'Memory/other/x.md'
        }, EMPTY_CTX)).rejects.toThrow(/outside project scope/);
    });
});