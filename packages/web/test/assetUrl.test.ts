import {describe, it, expect} from 'vitest';
import {resolveAssetUrl} from '../src/AssetUrl.js';

describe('resolveAssetUrl — pass-through cases', () => {
    it('returns null for absolute http URLs', () => {
        expect(resolveAssetUrl('https://example.com/img.png', 'Memory/p/foo.md')).toBeNull();
        expect(resolveAssetUrl('http://example.com/img.png', 'Memory/p/foo.md')).toBeNull();
    });

    it('returns null for data: URIs', () => {
        expect(resolveAssetUrl('data:image/png;base64,iVBOR...', 'Memory/p/foo.md')).toBeNull();
    });

    it('returns null for protocol-relative URLs', () => {
        expect(resolveAssetUrl('//cdn.example.com/img.png', 'Memory/p/foo.md')).toBeNull();
    });

    it('returns null for root-anchored paths', () => {
        expect(resolveAssetUrl('/api/asset?path=foo.png', 'Memory/p/foo.md')).toBeNull();
        expect(resolveAssetUrl('/static/logo.png', 'Memory/p/foo.md')).toBeNull();
    });

    it('returns null for empty src', () => {
        expect(resolveAssetUrl('', 'Memory/p/foo.md')).toBeNull();
    });

    it('returns null for unrecognized extensions', () => {
        expect(resolveAssetUrl('./_assets/file.txt', 'Memory/p/foo.md')).toBeNull();
        expect(resolveAssetUrl('./_assets/script.js', 'Memory/p/foo.md')).toBeNull();
    });

    it('returns null when there is no extension at all', () => {
        expect(resolveAssetUrl('./_assets/somefile', 'Memory/p/foo.md')).toBeNull();
    });
});

describe('resolveAssetUrl — rewriting', () => {
    it('rewrites note-relative ./_assets path to /api/asset?path=', () => {
        expect(resolveAssetUrl('./_assets/img-abcd.png', 'Memory/synaipse/foo.md'))
            .toBe('/api/asset?path=Memory%2Fsynaipse%2F_assets%2Fimg-abcd.png');
    });

    it('rewrites bare _assets/ path (no leading ./) the same way', () => {
        expect(resolveAssetUrl('_assets/img.jpg', 'Memory/synaipse/foo.md'))
            .toBe('/api/asset?path=Memory%2Fsynaipse%2F_assets%2Fimg.jpg');
    });

    it('handles ../_assets parent-directory escape into the project root', () => {
        expect(resolveAssetUrl('../_assets/img.png', 'Memory/synaipse/sub/bar.md'))
            .toBe('/api/asset?path=Memory%2Fsynaipse%2F_assets%2Fimg.png');
    });

    it('handles a top-level note (no Memory/ prefix)', () => {
        expect(resolveAssetUrl('_assets/img.svg', 'index.md'))
            .toBe('/api/asset?path=_assets%2Fimg.svg');
    });

    it('falls back to vault-root resolution when no noteId is given', () => {
        expect(resolveAssetUrl('_assets/img.png', undefined))
            .toBe('/api/asset?path=_assets%2Fimg.png');
    });

    it('preserves a #fragment on the output', () => {
        expect(resolveAssetUrl('./_assets/img.png#section', 'Memory/p/foo.md'))
            .toBe('/api/asset?path=Memory%2Fp%2F_assets%2Fimg.png#section');
    });

    it('preserves a ?query on the output', () => {
        expect(resolveAssetUrl('./_assets/img.png?v=2', 'Memory/p/foo.md'))
            .toBe('/api/asset?path=Memory%2Fp%2F_assets%2Fimg.png?v=2');
    });

    it('accepts all allow-listed image extensions', () => {
        for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg']) {
            const rewritten = resolveAssetUrl(`./_assets/img.${ext}`, 'Memory/p/foo.md');
            expect(rewritten, ext).not.toBeNull();
            expect(rewritten).toContain('/api/asset?path=');
        }
    });

    it('treats extensions case-insensitively', () => {
        expect(resolveAssetUrl('./_assets/IMG.PNG', 'Memory/p/foo.md'))
            .toBe('/api/asset?path=Memory%2Fp%2F_assets%2FIMG.PNG');
    });
});