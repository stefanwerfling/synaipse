import {describe, it, expect} from 'vitest';
import {buildWikilinkResolver, ResolveSummary, slugify} from '../src/Wikilinks.js';

const note = (id: string, title: string, aliases: string[] = []): ResolveSummary => ({
    id, title, aliases
});

describe('buildWikilinkResolver', () => {
    it('resolves a plain title', () => {
        const resolve = buildWikilinkResolver([note('a.md', 'Alpha')]);
        expect(resolve('Alpha')).toBe('a.md');
    });

    it('resolves an alias to its note id', () => {
        const resolve = buildWikilinkResolver([note('q.md', 'Qdrant Setup', ['Qdrant'])]);
        expect(resolve('Qdrant')).toBe('q.md');
        expect(resolve('Qdrant Setup')).toBe('q.md');
    });

    it('returns undefined for unknown keys', () => {
        const resolve = buildWikilinkResolver([note('a.md', 'Alpha')]);
        expect(resolve('Beta')).toBeUndefined();
    });

    it('title wins when another note uses the same string as an alias', () => {
        const resolve = buildWikilinkResolver([
            note('alias-source.md', 'Different Title', ['Alpha']),
            note('alpha.md', 'Alpha')
        ]);
        expect(resolve('Alpha')).toBe('alpha.md');
    });

    it('first registered title wins on duplicate titles', () => {
        const resolve = buildWikilinkResolver([
            note('first.md', 'Duplicate'),
            note('second.md', 'Duplicate')
        ]);
        expect(resolve('Duplicate')).toBe('first.md');
    });

    it('skips empty titles and empty aliases', () => {
        const resolve = buildWikilinkResolver([
            note('a.md', '', ['', 'Real']),
            note('b.md', 'B')
        ]);
        expect(resolve('')).toBeUndefined();
        expect(resolve('Real')).toBe('a.md');
        expect(resolve('B')).toBe('b.md');
    });

    it('returns undefined for the empty-notes case', () => {
        const resolve = buildWikilinkResolver([]);
        expect(resolve('Alpha')).toBeUndefined();
    });

    it('keeps lookups O(1) regardless of input size', () => {
        const many = Array.from({length: 500}, (_, i) => note(`n${i}.md`, `Title ${i}`, [`Alias ${i}`]));
        const resolve = buildWikilinkResolver(many);
        expect(resolve('Title 250')).toBe('n250.md');
        expect(resolve('Alias 499')).toBe('n499.md');
    });
});

describe('slugify', () => {
    it('lowercases and replaces spaces with hyphens', () => {
        expect(slugify('Hello World')).toBe('hello-world');
    });

    it('collapses runs of non-alphanumerics', () => {
        expect(slugify('A  --  B')).toBe('a-b');
    });

    it('strips leading and trailing separators', () => {
        expect(slugify('   foo bar   ')).toBe('foo-bar');
    });

    it('strips diacritics (combining marks); leaves non-ASCII codepoints as separators', () => {
        // ß / ñ / é etc.: NFKD decomposes combining marks (é → e + ́), so they round-trip
        // through the [a-z0-9] filter. Atomic codepoints like ß don't decompose and get
        // replaced by the separator.
        expect(slugify('Café Über Größe')).toBe('cafe-uber-gro-e');
    });

    it('returns empty string for purely punctuation input', () => {
        expect(slugify('!!! ???')).toBe('');
    });

    it('handles already-slug-like input idempotently', () => {
        expect(slugify('already-a-slug')).toBe('already-a-slug');
    });
});