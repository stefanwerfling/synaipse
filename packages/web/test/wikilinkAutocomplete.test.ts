import {describe, expect, it} from 'vitest';
import {findOpenWikilink} from '../src/WikilinkAutocomplete.js';

describe('findOpenWikilink', () => {
    it('matches an unclosed [[ before the caret', () => {
        const r = findOpenWikilink('See [[Qd', 8);
        expect(r).toEqual({matchStart: 4, query: 'Qd'});
    });

    it('returns null when no [[ precedes the caret', () => {
        expect(findOpenWikilink('plain text', 5)).toBeNull();
    });

    it('returns null when the link was already closed', () => {
        expect(findOpenWikilink('See [[Foo]] and [[B', 11)).toBeNull();
        expect(findOpenWikilink('[[done]] more', 8)).toBeNull();
    });

    it('honours the latest [[ when several are open', () => {
        const r = findOpenWikilink('[[Alpha]] but also [[Be', 23);
        expect(r).toEqual({matchStart: 19, query: 'Be'});
    });

    it('returns null when the cursor crosses a newline', () => {
        expect(findOpenWikilink('[[Foo\nBar', 9)).toBeNull();
    });

    it('returns an empty query right after `[[`', () => {
        const r = findOpenWikilink('See [[', 6);
        expect(r).toEqual({matchStart: 4, query: ''});
    });

    it('handles caret in the middle of the document', () => {
        const text = 'before [[Qdr after';
        const caret = 'before [[Qdr'.length;
        const r = findOpenWikilink(text, caret);
        expect(r).toEqual({matchStart: 7, query: 'Qdr'});
    });

    it('treats a single ] as a close (defensive)', () => {
        expect(findOpenWikilink('[[Foo] bar', 10)).toBeNull();
    });
});