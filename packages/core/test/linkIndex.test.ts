import {describe, it, expect} from 'vitest';
import {LinkIndex, type LinkIndexNote} from '../src/LinkIndex.js';

const note = (id: string, title: string, wikilinks: string[] = [], aliases?: string[]): LinkIndexNote => ({
    id,
    title,
    wikilinks,
    frontmatter: aliases === undefined ? {} : {aliases}
});

describe('LinkIndex', () => {
    it('resolves backlinks by title, keyed by note id', () => {
        const idx = new LinkIndex();
        idx.upsert(note('a.md', 'A', ['B']));
        idx.upsert(note('b.md', 'B'));
        expect(idx.backlinksOf('b.md')).toEqual(['a.md']);
        expect(idx.backlinksOf('B')).toEqual([]);
        expect(idx.backlinksOf('a.md')).toEqual([]);
    });

    it('resolves aliases, title wins over alias on collision', () => {
        const idx = new LinkIndex();
        idx.upsert(note('t.md', 'Target', [], ['tgt']));
        idx.upsert(note('other.md', 'tgt'));       // a TITLE "tgt" beats the alias
        idx.upsert(note('s.md', 'S', ['tgt', 'Target']));
        expect(idx.resolve('tgt')).toBe('other.md');
        expect(idx.backlinksOf('t.md')).toEqual(['s.md']);
        expect(idx.backlinksOf('other.md')).toEqual(['s.md']);
    });

    it('first-indexed note wins on duplicate titles', () => {
        const idx = new LinkIndex();
        idx.upsert(note('one.md', 'Dup'));
        idx.upsert(note('two.md', 'Dup'));
        idx.upsert(note('s.md', 'S', ['Dup']));
        expect(idx.backlinksOf('one.md')).toEqual(['s.md']);
        expect(idx.backlinksOf('two.md')).toEqual([]);
        idx.remove('one.md');
        expect(idx.backlinksOf('two.md')).toEqual(['s.md']);
    });

    it('updates incrementally when links, titles and aliases change', () => {
        const idx = new LinkIndex();
        idx.upsert(note('b.md', 'B'));
        idx.upsert(note('a.md', 'A', ['B']));
        idx.upsert(note('a.md', 'A', []));
        expect(idx.backlinksOf('b.md')).toEqual([]);

        idx.upsert(note('a.md', 'A', ['Bee']));
        expect(idx.backlinksOf('b.md')).toEqual([]);
        idx.upsert(note('b.md', 'B', [], ['Bee']));
        expect(idx.backlinksOf('b.md')).toEqual(['a.md']);

        idx.upsert(note('b.md', 'Renamed'));
        expect(idx.backlinksOf('b.md')).toEqual([]);
        idx.remove('a.md');
        idx.upsert(note('b.md', 'Renamed', [], ['Bee']));
        expect(idx.backlinksOf('b.md')).toEqual([]);
    });

    it('ignores self-links and duplicate links', () => {
        const idx = new LinkIndex();
        idx.upsert(note('a.md', 'A', ['A', 'A']));
        expect(idx.backlinksOf('a.md')).toEqual([]);
    });
});
