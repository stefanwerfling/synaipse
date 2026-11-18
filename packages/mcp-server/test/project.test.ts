import {describe, it, expect} from 'vitest';
import {
    projectFromUrlPath,
    projectFromHeader,
    projectFromDirHeader,
    resolveProjectFromRequest,
    authorFromHeader,
    extraTagsFromHeader,
    resolveContextFromRequest
} from '../src/Project.js';

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

describe('authorFromHeader', () => {
    it('parses a "Name <email>" header', () => {
        const author = authorFromHeader({'x-synaipse-author': 'Alice <alice@example.com>'});
        expect(author).toEqual({name: 'Alice', email: 'alice@example.com'});
    });

    it('returns undefined for missing or empty header', () => {
        expect(authorFromHeader({})).toBeUndefined();
        expect(authorFromHeader({'x-synaipse-author': '   '})).toBeUndefined();
    });

    it('returns undefined for malformed header instead of throwing', () => {
        expect(authorFromHeader({'x-synaipse-author': 'no-angle-brackets'})).toBeUndefined();
    });

    it('uses the first value when the header is repeated', () => {
        expect(authorFromHeader({
            'x-synaipse-author': ['First <a@b>', 'Second <c@d>']
        })).toEqual({name: 'First', email: 'a@b'});
    });
});

describe('extraTagsFromHeader', () => {
    it('parses a comma-separated list', () => {
        expect(extraTagsFromHeader({
            'x-synaipse-project-tags': 'team/backend, kind/service'
        })).toEqual(['team/backend', 'kind/service']);
    });

    it('returns undefined for missing or empty header', () => {
        expect(extraTagsFromHeader({})).toBeUndefined();
        expect(extraTagsFromHeader({'x-synaipse-project-tags': ''})).toBeUndefined();
    });

    it('drops invalid tag characters silently', () => {
        expect(extraTagsFromHeader({
            'x-synaipse-project-tags': 'ok, bad space, also-ok'
        })).toEqual(['ok', 'also-ok']);
    });

    it('returns undefined when all tags are filtered out', () => {
        expect(extraTagsFromHeader({
            'x-synaipse-project-tags': '   ,   '
        })).toBeUndefined();
    });
});

describe('resolveContextFromRequest', () => {
    it('merges project from URL with author and tags from headers', () => {
        const ctx = resolveContextFromRequest({
            url: '/mcp/from-path',
            headers: {
                'x-synaipse-author': 'Bob <bob@example.com>',
                'x-synaipse-project-tags': 'team/db,kind/store'
            },
            basePath: '/mcp'
        });

        expect(ctx.project).toBe('from-path');
        expect(ctx.gitAuthor).toEqual({name: 'Bob', email: 'bob@example.com'});
        expect(ctx.extraTags).toEqual(['team/db', 'kind/store']);
    });

    it('returns an empty object when no resolvable signal exists', () => {
        const ctx = resolveContextFromRequest({
            url: '/mcp',
            headers: {},
            basePath: '/mcp'
        });
        expect(ctx).toEqual({});
    });
});
describe('projectFromDirHeader', () => {
    it('uses the folder name of the client project dir, made project-safe', () => {
        expect(projectFromDirHeader({'x-synaipse-project-dir': '/home/a/code/synaipse'})).toBe('synaipse');
        expect(projectFromDirHeader({'x-synaipse-project-dir': '/home/a/code/my app/'})).toBe('my-app');
        expect(projectFromDirHeader({'x-synaipse-project-dir': 'C:\\work\\kavula'})).toBe('kavula');
        expect(projectFromDirHeader({'x-synaipse-project-dir': '/'})).toBeUndefined();
        expect(projectFromDirHeader({})).toBeUndefined();
    });

    it('ranks after the URL segment and the explicit project header', () => {
        const headers = {'x-synaipse-project-dir': '/code/fromdir'};
        expect(resolveProjectFromRequest({url: '/mcp/fromurl', headers, basePath: '/mcp'})).toBe('fromurl');
        expect(resolveProjectFromRequest({url: '/mcp/', headers: {...headers, 'x-synaipse-project': 'explicit'}, basePath: '/mcp'})).toBe('explicit');
        expect(resolveProjectFromRequest({url: '/mcp/', headers, basePath: '/mcp'})).toBe('fromdir');
    });
});
