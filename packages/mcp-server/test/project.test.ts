import {describe, it, expect} from 'vitest';
import {projectFromUrlPath, projectFromHeader, resolveProjectFromRequest} from '../src/Project.js';

describe('projectFromUrlPath', () => {
    it('extracts the project segment after the base path', () => {
        expect(projectFromUrlPath('/mcp/app-a', '/mcp')).toBe('app-a');
    });

    it('extracts the project before the next slash', () => {
        expect(projectFromUrlPath('/mcp/app-a/tail', '/mcp')).toBe('app-a');
    });

    it('strips query strings before matching', () => {
        expect(projectFromUrlPath('/mcp/app-a?x=1', '/mcp')).toBe('app-a');
    });

    it('returns undefined for the bare base path', () => {
        expect(projectFromUrlPath('/mcp', '/mcp')).toBeUndefined();
        expect(projectFromUrlPath('/mcp/', '/mcp')).toBeUndefined();
    });

    it('returns undefined when the url does not start with the base path', () => {
        expect(projectFromUrlPath('/other/app-a', '/mcp')).toBeUndefined();
    });

    it('rejects unsafe characters in the project segment', () => {
        expect(projectFromUrlPath('/mcp/..%2Fescape', '/mcp')).toBeUndefined();
        expect(projectFromUrlPath('/mcp/has space', '/mcp')).toBeUndefined();
    });

    it('accepts dots, dashes, underscores', () => {
        expect(projectFromUrlPath('/mcp/app.v2_alpha-1', '/mcp')).toBe('app.v2_alpha-1');
    });

    it('handles undefined url', () => {
        expect(projectFromUrlPath(undefined, '/mcp')).toBeUndefined();
    });
});

describe('projectFromHeader', () => {
    it('reads x-synaipse-project (lowercase)', () => {
        expect(projectFromHeader({'x-synaipse-project': 'app-a'})).toBe('app-a');
    });

    it('trims whitespace', () => {
        expect(projectFromHeader({'x-synaipse-project': '  app-a  '})).toBe('app-a');
    });

    it('returns undefined when missing or empty', () => {
        expect(projectFromHeader({})).toBeUndefined();
        expect(projectFromHeader({'x-synaipse-project': ''})).toBeUndefined();
    });

    it('rejects unsafe characters', () => {
        expect(projectFromHeader({'x-synaipse-project': 'has space'})).toBeUndefined();
    });

    it('uses the first value when the header is repeated', () => {
        expect(projectFromHeader({'x-synaipse-project': ['app-a', 'app-b']})).toBe('app-a');
    });
});

describe('resolveProjectFromRequest', () => {
    it('prefers URL path over header', () => {
        const project = resolveProjectFromRequest({
            url: '/mcp/from-path',
            headers: {'x-synaipse-project': 'from-header'},
            basePath: '/mcp'
        });
        expect(project).toBe('from-path');
    });

    it('falls back to header when URL has no project', () => {
        const project = resolveProjectFromRequest({
            url: '/mcp',
            headers: {'x-synaipse-project': 'from-header'},
            basePath: '/mcp'
        });
        expect(project).toBe('from-header');
    });

    it('returns undefined when neither provides one', () => {
        const project = resolveProjectFromRequest({
            url: '/mcp',
            headers: {},
            basePath: '/mcp'
        });
        expect(project).toBeUndefined();
    });
});