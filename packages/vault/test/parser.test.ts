import {describe, it, expect} from 'vitest';
import {extractTags, extractWikilinks, parseNote} from '../src/Parser.js';

describe('extractWikilinks', () => {
    it('finds plain wikilinks', () => {
        expect(extractWikilinks('see [[Note A]] and [[Note B]]')).toEqual(['Note A', 'Note B']);
    });

    it('strips aliases and anchors', () => {
        expect(extractWikilinks('refer to [[Topic#Section|alias]]')).toEqual(['Topic']);
    });

    it('ignores wikilinks inside code blocks and inline code', () => {
        const md = '`[[NotALink]]` and ```\n[[AlsoNot]]\n``` but [[RealLink]]';
        expect(extractWikilinks(md)).toEqual(['RealLink']);
    });

    it('deduplicates', () => {
        expect(extractWikilinks('[[A]] and [[A]] again')).toEqual(['A']);
    });
});

describe('extractTags', () => {
    it('merges frontmatter tags with inline #tags', () => {
        const tags = extractTags('body with #inline-tag and #another/nested', {tags: ['fm-tag']});
        expect(tags).toEqual(expect.arrayContaining(['fm-tag', 'inline-tag', 'another/nested']));
    });

    it('ignores tags in code fences', () => {
        const md = '```\n#not-a-tag\n``` real #yes';
        expect(extractTags(md, {})).toEqual(['yes']);
    });
});

describe('parseNote', () => {
    it('parses frontmatter, title, content and hash', () => {
        const raw = '---\ntitle: My Note\ntags: [a, b]\n---\n\n# Heading\n\nbody with [[Link]]';
        const note = parseNote({vaultRoot: '/v', absolutePath: '/v/sub/x.md', raw, mtime: 100});

        expect(note.id).toBe('sub/x.md');
        expect(note.title).toBe('My Note');
        expect(note.tags).toEqual(expect.arrayContaining(['a', 'b']));
        expect(note.wikilinks).toEqual(['Link']);
        expect(note.hash).toHaveLength(40);
    });

    it('falls back to first H1 then filename for title', () => {
        const fromHeading = parseNote({
            vaultRoot: '/v',
            absolutePath: '/v/no-fm.md',
            raw: '# Heading Title\n\nbody',
            mtime: 0
        });
        expect(fromHeading.title).toBe('Heading Title');

        const fromFilename = parseNote({
            vaultRoot: '/v',
            absolutePath: '/v/just-a-name.md',
            raw: 'no heading body',
            mtime: 0
        });
        expect(fromFilename.title).toBe('just-a-name');
    });
});