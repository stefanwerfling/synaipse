import {describe, expect, it} from 'vitest';
import {dirPrefixes, folderOf, inScope, intersectScopes, isUnscoped} from '../src/Scope.js';

describe('Scope', () => {
    it('lists folder prefixes with a root marker', () => {
        expect(dirPrefixes('Memory/p/x.md')).toEqual(['/', 'Memory/', 'Memory/p/']);
        expect(dirPrefixes('root.md')).toEqual(['/']);
    });

    it('reduces a prefix to its folder', () => {
        expect(folderOf('Memory/dec')).toBe('Memory/');
        expect(folderOf('Memory/p/')).toBe('Memory/p/');
        expect(folderOf('Mem')).toBe('/');
    });

    it('matches include (any) and exclude (none)', () => {
        const scope = {include: ['Memory/a/', 'Projects/'], exclude: ['Memory/a/private/']};
        expect(inScope('Memory/a/x.md', scope)).toBe(true);
        expect(inScope('Projects/y.md', scope)).toBe(true);
        expect(inScope('Memory/b/x.md', scope)).toBe(false);
        expect(inScope('Memory/a/private/z.md', scope)).toBe(false);
        expect(inScope('anything.md', undefined)).toBe(true);
        expect(isUnscoped({include: [], exclude: []})).toBe(true);
    });

    it('intersects a requested scope with a token scope', () => {
        expect(intersectScopes({include: ['Memory/p/']}, {include: ['Memory/']})).toEqual({include: ['Memory/p/']});
        expect(intersectScopes({include: ['Memory/']}, {include: ['Memory/p/', 'Memory/q/']})).toEqual({include: ['Memory/p/', 'Memory/q/']});
        expect(intersectScopes({include: ['Clipped/']}, {include: ['Memory/']})).toBeNull();
        expect(intersectScopes({exclude: ['Clipped/']}, {include: ['Memory/']})).toEqual({include: ['Memory/'], exclude: ['Clipped/']});
        expect(intersectScopes(undefined, undefined)).toEqual({});
    });
});
