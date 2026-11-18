import {describe, it, expect, afterEach} from 'vitest';
import {apiUrl, getApiBase, setApiBase} from '../src/ApiBase.js';
import {resolveAssetUrl} from '../src/AssetUrl.js';

/** Plan P3 / E1: one helper for every API URL. */

afterEach(() => setApiBase(''));

describe('apiUrl', () => {
    it('is the identity standalone', () => {
        expect(apiUrl('/api/notes')).toBe('/api/notes');
    });

    it('prefixes the mount base and normalises it', () => {
        setApiBase('synaipse/');
        expect(getApiBase()).toBe('/synaipse');
        expect(apiUrl('/api/notes?x=1')).toBe('/synaipse/api/notes?x=1');
        setApiBase('https://host:3001/');
        expect(apiUrl('/api/info')).toBe('https://host:3001/api/info');
    });

    it('leaves absolute URLs alone', () => {
        setApiBase('/synaipse');
        expect(apiUrl('https://example.org/api/x')).toBe('https://example.org/api/x');
    });

    it('asset image URLs follow the base', () => {
        setApiBase('/synaipse');
        expect(resolveAssetUrl('_assets/a.png', 'note.md')).toMatch(/^\/synaipse\/api\/asset\?path=/);
    });
});
