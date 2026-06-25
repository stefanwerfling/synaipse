import {describe, it, expect} from 'vitest';
import {extractTypedLinks, isTypedLinkKind, TYPED_LINK_KINDS} from '../src/Index.js';

describe('isTypedLinkKind', () => {
    it('accepts every documented kind', () => {
        for (const kind of TYPED_LINK_KINDS) {
            expect(isTypedLinkKind(kind)).toBe(true);
        }
    });

    it('rejects unknown values', () => {
        expect(isTypedLinkKind('cites')).toBe(false);
        expect(isTypedLinkKind('')).toBe(false);
        expect(isTypedLinkKind(undefined)).toBe(false);
        expect(isTypedLinkKind(null)).toBe(false);
        expect(isTypedLinkKind(42)).toBe(false);
    });
});

describe('extractTypedLinks', () => {
    it('returns empty for frontmatter without links', () => {
        expect(extractTypedLinks({})).toEqual([]);
        expect(extractTypedLinks({title: 'X'})).toEqual([]);
    });

    it('returns empty when links is not an array', () => {
        expect(extractTypedLinks({links: 'oops'} as never)).toEqual([]);
        expect(extractTypedLinks({links: {target: 'A', kind: 'supersedes'}} as never)).toEqual([]);
    });

    it('extracts well-formed entries', () => {
        const result = extractTypedLinks({
            links: [
                {target: 'Foo', kind: 'supersedes'},
                {target: 'Bar', kind: 'relates_to'},
                {target: 'Baz', kind: 'duplicates'},
                {target: 'Qux', kind: 'replies_to'}
            ]
        });

        expect(result).toEqual([
            {target: 'Foo', kind: 'supersedes'},
            {target: 'Bar', kind: 'relates_to'},
            {target: 'Baz', kind: 'duplicates'},
            {target: 'Qux', kind: 'replies_to'}
        ]);
    });

    it('skips entries with missing target', () => {
        const result = extractTypedLinks({
            links: [
                {kind: 'supersedes'} as never,
                {target: '', kind: 'supersedes'},
                {target: 'OK', kind: 'supersedes'}
            ]
        });

        expect(result).toEqual([{target: 'OK', kind: 'supersedes'}]);
    });

    it('skips entries with unknown kind', () => {
        const result = extractTypedLinks({
            links: [
                {target: 'A', kind: 'cites'} as never,
                {target: 'B', kind: 'relates_to'}
            ]
        });

        expect(result).toEqual([{target: 'B', kind: 'relates_to'}]);
    });

    it('skips non-object entries', () => {
        const result = extractTypedLinks({
            links: [
                null as never,
                'bare-string' as never,
                42 as never,
                {target: 'Survivor', kind: 'replies_to'}
            ]
        });

        expect(result).toEqual([{target: 'Survivor', kind: 'replies_to'}]);
    });
});