import {describe, expect, it} from 'vitest';
import matter from 'gray-matter';
import {parseNote} from '../src/Parser.js';
import {NO_CACHE} from '../src/MatterOptions.js';

describe('gray-matter cache', () => {
    it('parsing notes does not grow gray-matter\'s process-wide cache', () => {
        matter.clearCache();
        for (let i = 0; i < 5; i++) {
            parseNote({vaultRoot: '/v', absolutePath: `/v/n${i}.md`, raw: `---\ntitle: N${i}\n---\nbody ${i}`, mtime: 0});
        }
        matter.stringify('body', {a: 1}, NO_CACHE);
        expect(Object.keys((matter as unknown as {cache: object}).cache)).toHaveLength(0);
    });

    it('the no-cache options keep default parsing', () => {
        const parsed = matter('---\ntitle: T\ntags: [a]\n---\n# Body\n', NO_CACHE);
        expect(parsed.data).toEqual({title: 'T', tags: ['a']});
        expect(parsed.content).toBe('# Body\n');
    });
});

describe('gray-matter JavaScript front matter', () => {
    const probe = '__synaipseMatterProbe';
    const evil = (lang: string): string =>
        `---${lang}\n{title: (() => { globalThis.${probe} = '${lang}'; return 'x'; })()}\n---\nbody\n`;

    it('is never evaluated, neither when parsing nor when stringifying', () => {
        for (const lang of ['js', 'javascript', ' js']) {
            delete (globalThis as Record<string, unknown>)[probe];
            const note = parseNote({vaultRoot: '/v', absolutePath: '/v/x.md', raw: evil(lang), mtime: 0});
            expect(note.frontmatter).toEqual({});
            // Writing such content is refused (until gray-matter is replaced).
            expect(() => matter.stringify(evil(lang), {title: 'T'}, NO_CACHE)).toThrow(/not supported/);
            expect((globalThis as Record<string, unknown>)[probe]).toBeUndefined();
        }
    });
});
