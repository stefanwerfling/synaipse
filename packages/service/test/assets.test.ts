import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {assetsFolderForNote, relativeAssetPath, writeAsset} from '../src/Assets.js';

describe('assetsFolderForNote', () => {
    it('returns Memory/<project>/_assets for project-scoped notes', () => {
        expect(assetsFolderForNote('Memory/swipemeister/decisions/auth.md'))
            .toBe('Memory/swipemeister/_assets');

        expect(assetsFolderForNote('Memory/my-app/notes/x/y/z.md'))
            .toBe('Memory/my-app/_assets');
    });

    it('falls back to root _assets for non-Memory paths', () => {
        expect(assetsFolderForNote('Crawler/whatever.md')).toBe('_assets');
        expect(assetsFolderForNote('top-level.md')).toBe('_assets');
    });
});

describe('relativeAssetPath', () => {
    it('walks up from a deeply nested note to a sibling _assets folder', () => {
        const rel = relativeAssetPath(
            'Memory/proj/decisions/2026-01-01-x.md',
            'Memory/proj/_assets/img-abc.png'
        );
        expect(rel).toBe('../_assets/img-abc.png');
    });

    it('handles a note directly in the project root', () => {
        const rel = relativeAssetPath(
            'Memory/proj/foo.md',
            'Memory/proj/_assets/img-abc.png'
        );
        expect(rel).toBe('./_assets/img-abc.png');
    });

    it('handles very deep nesting (multiple ../)', () => {
        const rel = relativeAssetPath(
            'Memory/proj/a/b/c/d/note.md',
            'Memory/proj/_assets/img-abc.png'
        );
        expect(rel).toBe('../../../../_assets/img-abc.png');
    });

    it('handles a vault-root note + vault-root asset', () => {
        const rel = relativeAssetPath('top.md', '_assets/img-abc.png');
        expect(rel).toBe('./_assets/img-abc.png');
    });
});

describe('writeAsset', () => {
    let vault: string;

    beforeEach(async () => {
        vault = await mkdtemp(path.join(tmpdir(), 'assets-'));
    });

    afterEach(async () => {
        await rm(vault, {recursive: true, force: true});
    });

    it('writes a PNG to Memory/<project>/_assets with a hash filename', async () => {
        const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

        const result = await writeAsset({
            vaultPath: vault,
            noteId: 'Memory/proj/foo.md',
            content: PNG,
            contentType: 'image/png'
        });

        expect(result.deduped).toBe(false);
        expect(result.written).toBe(PNG.length);
        expect(result.assetId).toMatch(/^Memory\/proj\/_assets\/img-[0-9a-f]{12}\.png$/);
        expect(result.relativePath).toMatch(/^\.\/_assets\/img-[0-9a-f]{12}\.png$/);

        const onDisk = await readFile(path.join(vault, result.assetId));
        expect(onDisk.equals(PNG)).toBe(true);
    });

    it('dedupes the same content on a second write', async () => {
        const buf = Buffer.from('hello');

        const a = await writeAsset({
            vaultPath: vault,
            noteId: 'Memory/p/x.md',
            content: buf,
            contentType: 'image/png'
        });
        const b = await writeAsset({
            vaultPath: vault,
            noteId: 'Memory/p/x.md',
            content: buf,
            contentType: 'image/png'
        });

        expect(b.assetId).toBe(a.assetId);
        expect(b.deduped).toBe(true);
        expect(b.written).toBe(0);
    });

    it('picks the right extension from the mime type', async () => {
        const buf = Buffer.from('x');
        const jpg = await writeAsset({
            vaultPath: vault,
            noteId: 'Memory/p/x.md',
            content: buf,
            contentType: 'image/jpeg'
        });
        const gif = await writeAsset({
            vaultPath: vault,
            noteId: 'Memory/p/x.md',
            content: Buffer.from('y'),
            contentType: 'image/gif'
        });

        expect(jpg.assetId.endsWith('.jpg')).toBe(true);
        expect(gif.assetId.endsWith('.gif')).toBe(true);
    });

    it('falls back to .bin for unknown content types', async () => {
        const result = await writeAsset({
            vaultPath: vault,
            noteId: 'Memory/p/x.md',
            content: Buffer.from('weird'),
            contentType: 'application/x-weird'
        });
        expect(result.assetId.endsWith('.bin')).toBe(true);
    });

    it('includes the relative path so the editor can drop ![](rel) directly', async () => {
        const result = await writeAsset({
            vaultPath: vault,
            noteId: 'Memory/proj/decisions/auth.md',
            content: Buffer.from('z'),
            contentType: 'image/png'
        });
        expect(result.relativePath.startsWith('../_assets/img-')).toBe(true);
    });
});