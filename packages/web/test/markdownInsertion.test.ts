import {describe, expect, it} from 'vitest';
import {
    buildContainerAttrs,
    insertAt,
    insertCodeBlock,
    insertContainer,
    insertLink,
    prefixLines,
    wrap
} from '../src/MarkdownInsertion.js';

describe('wrap', () => {
    it('wraps the selection and reselects the original span', () => {
        const r = wrap('Hello world', 6, 11, '**', '**', 'bold');
        expect(r.value).toBe('Hello **world**');
        expect(r.selStart).toBe(8);
        expect(r.selEnd).toBe(13);
    });

    it('inserts placeholder when no selection — placeholder becomes the new selection', () => {
        const r = wrap('Hello ', 6, 6, '**', '**', 'bold');
        expect(r.value).toBe('Hello ****bold****'.replace('****bold****', '**bold**'));
        expect(r.value).toBe('Hello **bold**');
        expect(r.value.slice(r.selStart, r.selEnd)).toBe('bold');
    });
});

describe('prefixLines', () => {
    it('prefixes a single selected line', () => {
        const r = prefixLines('alpha\nbeta\ngamma', 0, 5, '# ');
        expect(r.value).toBe('# alpha\nbeta\ngamma');
    });

    it('prefixes every line touched by the selection', () => {
        const r = prefixLines('alpha\nbeta\ngamma', 2, 12, '> ');
        expect(r.value).toBe('> alpha\n> beta\n> gamma');
    });

    it('expands to line boundaries (cursor in the middle of one line)', () => {
        const r = prefixLines('alpha\nbeta', 2, 2, '- ');
        expect(r.value).toBe('- alpha\nbeta');
    });
});

describe('insertAt', () => {
    it('inserts at the caret and moves cursor after it', () => {
        const r = insertAt('Hello world', 5, 5, '!');
        expect(r.value).toBe('Hello! world');
        expect(r.selStart).toBe(6);
        expect(r.selEnd).toBe(6);
    });

    it('replaces a selection', () => {
        const r = insertAt('Hello world', 6, 11, 'Markdown');
        expect(r.value).toBe('Hello Markdown');
    });
});

describe('insertLink', () => {
    it('uses selected text as the label, selects the `url` placeholder', () => {
        const r = insertLink('see the docs', 4, 12);
        expect(r.value).toBe('see [the docs](url)');
        expect(r.value.slice(r.selStart, r.selEnd)).toBe('url');
    });

    it('falls back to `text` placeholder when nothing selected', () => {
        const r = insertLink('', 0, 0);
        expect(r.value).toBe('[text](url)');
        expect(r.value.slice(r.selStart, r.selEnd)).toBe('url');
    });
});

describe('insertCodeBlock', () => {
    it('wraps selection in a fenced block, selects the body', () => {
        const r = insertCodeBlock('hello', 0, 5);
        expect(r.value).toBe('\n```\nhello\n```\n');
        expect(r.value.slice(r.selStart, r.selEnd)).toBe('hello');
    });

    it('uses `code` placeholder when no selection', () => {
        const r = insertCodeBlock('', 0, 0);
        expect(r.value).toBe('\n```\ncode\n```\n');
        expect(r.value.slice(r.selStart, r.selEnd)).toBe('code');
    });
});

describe('buildContainerAttrs', () => {
    it('returns empty string when no attrs given', () => {
        expect(buildContainerAttrs({})).toBe('');
    });

    it('builds the full attr object in declared order', () => {
        const out = buildContainerAttrs({icon: '🚀', color: 'blue', step: 1});
        expect(out).toBe(' { icon: "🚀", color: "blue", step: 1 }');
    });

    it('skips undefined fields', () => {
        expect(buildContainerAttrs({step: 2})).toBe(' { step: 2 }');
        expect(buildContainerAttrs({icon: '💡'})).toBe(' { icon: "💡" }');
    });
});

describe('insertContainer', () => {
    it('inserts a fenced block with attrs, selects the body', () => {
        const attrs = buildContainerAttrs({icon: '🚀', step: 1});
        const r = insertContainer('', 0, 0, 'infographic', attrs);
        expect(r.value).toBe('::: infographic { icon: "🚀", step: 1 }\nContent\n:::\n');
        expect(r.value.slice(r.selStart, r.selEnd)).toBe('Content');
    });

    it('uses selected text as body', () => {
        const r = insertContainer('Phase Alpha', 0, 11, 'infographic', '');
        expect(r.value).toContain('::: infographic\nPhase Alpha\n:::\n');
        expect(r.value.slice(r.selStart, r.selEnd)).toBe('Phase Alpha');
    });

    it('prepends a newline when caret is not at start of line', () => {
        const r = insertContainer('Hello ', 6, 6, 'tip', '');
        expect(r.value).toBe('Hello \n::: tip\nContent\n:::\n');
    });

    it('does NOT prepend a newline when already at start of line', () => {
        const r = insertContainer('Hello\n', 6, 6, 'tip', '');
        expect(r.value).toBe('Hello\n::: tip\nContent\n:::\n');
    });
});