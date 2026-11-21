import {describe, expect, it} from 'vitest';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseFrontMatter, stringifyFrontMatter} from '../src/FrontMatter.js';
import {parseNote} from '../src/Parser.js';
import {Vault} from '../src/Vault.js';

/**
 * Plan G5: front matter without gray-matter. The expectations of the
 * "as gray-matter" cases were taken from gray-matter 4.0.3; the real vault
 * (3289 notes) parses to the same data and body with both.
 */

describe('parseFrontMatter, as gray-matter read it', () => {
    const cases: Array<[string, string, Record<string, unknown>, string]> = [
        ['plain', '---\ntitle: T\ntags: [a]\n---\n# Body\n', {title: 'T', tags: ['a']}, '# Body\n'],
        ['BOM', '﻿---\ntitle: T\n---\nbody', {title: 'T'}, 'body'],
        ['CRLF', '---\r\ntitle: T\r\ntags:\r\n  - a\r\n---\r\nbody\r\n', {title: 'T', tags: ['a']}, 'body\r\n'],
        ['four dashes open nothing', '----\ntitle: T\n----\nbody', {}, '----\ntitle: T\n----\nbody'],
        ['no closing line', '---\ntitle: T\n', {title: 'T'}, ''],
        ['comment-only block', '---\n# just a comment\n---\nbody', {}, 'body'],
        ['empty block', '---\n---\nbody', {}, 'body'],
        ['---yaml', '---yaml\ntitle: T\n---\nbody', {title: 'T'}, 'body'],
        ['---YAML', '---YAML\ntitle: T\n---\nbody', {title: 'T'}, 'body'],
        ['longer closing line', '---\ntitle: T\n------\nbody', {title: 'T'}, '---\nbody'],
        ['one line break dropped', '---\ntitle: T\n---\n\nbody', {title: 'T'}, '\nbody'],
        ['only the delimiter', '---', {}, ''],
        ['empty file', '', {}, ''],
        ['not at the start', '# hi\n---\nx', {}, '# hi\n---\nx']
    ];
    for (const [name, raw, data, content] of cases) {
        it(name, () => {
            const parsed = parseFrontMatter(raw);
            expect(parsed.data).toEqual(data);
            expect(parsed.content).toBe(content);
            expect(parsed.error).toBeUndefined();
        });
    }

    it('reads dates as Date, like js-yaml 3 did', () => {
        expect(parseFrontMatter('---\ncreated: 2024-01-02\n---\nx').data.created).toEqual(new Date('2024-01-02T00:00:00.000Z'));
    });
});

describe('parseFrontMatter, deliberately unlike gray-matter', () => {
    const probe = '__synaipseFrontMatterProbe';

    it('never runs a ---js block; other languages are body too', () => {
        for (const lang of ['js', 'javascript', 'JS', 'json', 'coffee', 'toml']) {
            delete (globalThis as Record<string, unknown>)[probe];
            const raw = `---${lang}\n{title: (() => { globalThis.${probe} = 1; return 'x'; })()}\n---\nbody\n`;
            const parsed = parseFrontMatter(raw);
            expect(parsed).toMatchObject({data: {}, content: raw});
            expect(parsed.error).toMatch(/only YAML/);
            expect(stringifyFrontMatter(raw, {title: 'T'})).toBe(`---\ntitle: T\n---\n${raw}`);
            expect((globalThis as Record<string, unknown>)[probe]).toBeUndefined();
        }
    });

    it('keeps a block that is not valid YAML, or not a mapping, as body', () => {
        for (const block of ['a: [', 'just a sentence', '- a\n- b', '2024-01-02']) {
            const raw = `---\n${block}\n---\nbody`;
            const parsed = parseFrontMatter(raw);
            expect(parsed.data).toEqual({});
            expect(parsed.content).toBe(raw);
            expect(parsed.error).toMatch(/YAML/);
        }
    });

    it('caches nothing: the same text twice gives two separate objects', () => {
        const raw = '---\ntags: [a]\n---\nx';
        const a = parseFrontMatter(raw);
        (a.data.tags as string[]).push('b');
        expect(parseFrontMatter(raw).data.tags).toEqual(['a']);
    });
});

describe('stringifyFrontMatter', () => {
    it('writes the block, then the body ending in a line break', () => {
        expect(stringifyFrontMatter('# Body', {title: 'T', tags: ['a', 'b']})).toBe('---\ntitle: T\ntags:\n  - a\n  - b\n---\n# Body\n');
        expect(stringifyFrontMatter('', {title: 'T'})).toBe('---\ntitle: T\n---\n\n');
    });

    it('writes no block for empty data', () => {
        expect(stringifyFrontMatter('body', {})).toBe('body\n');
    });

    it('merges a block at the start of the content; the given data wins', () => {
        expect(stringifyFrontMatter('---\ntitle: Old\nsource: mcp\n---\nbody\n', {title: 'New', tags: ['p']}))
            .toBe('---\ntitle: New\nsource: mcp\ntags:\n  - p\n---\nbody\n');
    });

    it('drops undefined values (gray-matter threw)', () => {
        expect(stringifyFrontMatter('x', {a: 1, b: undefined})).toBe('---\na: 1\n---\nx\n');
    });

    it('round-trips awkward values', () => {
        const data = {
            title: 'MCP Isn\'t Magic: it\'s a door',
            url: 'https://example.org/a?b=c#d',
            description: `🦛 ${'long text '.repeat(20)}— with a dash`,
            multiline: 'line one\nline two\n',
            yes: 'yes', no: 'no', num: '0012', empty: '', hash: '#tag', star: '*x', colon: 'a: b',
            created: new Date('2024-01-02T03:04:05.000Z'),
            nested: {list: [1, 'two', {three: 3}], flag: false, nothing: null},
            consent: 'denied'
        };
        const file = stringifyFrontMatter('Body with --- inside\n', data);
        const back = parseFrontMatter(file);
        expect(back.data).toEqual(data);
        expect(back.content).toBe('Body with --- inside\n');
        expect(stringifyFrontMatter(back.content, back.data)).toBe(file);
    });
});

describe('the vault with front matter it cannot read', () => {
    it('loads every note; the broken block stays readable in the body', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'synaipse-fm-'));
        try {
            await writeFile(path.join(dir, 'good.md'), '---\ntitle: Good\n---\nok\n');
            await writeFile(path.join(dir, 'broken.md'), '---\ntitle: [unclosed\n---\ntext\n');
            await writeFile(path.join(dir, 'js.md'), '---js\n{title: "x"}\n---\ntext\n');
            const vault = new Vault(dir);
            await vault.load();
            expect(vault.list().map((n) => n.id).sort()).toEqual(['broken.md', 'good.md', 'js.md']);
            expect(vault.get('good.md').title).toBe('Good');
            expect(vault.get('broken.md').content).toBe('---\ntitle: [unclosed\n---\ntext\n');
            expect(vault.get('js.md').frontmatter).toEqual({});
        } finally {
            await rm(dir, {recursive: true, force: true});
        }
    });

    it('parseNote takes the title from the body heading when the block is ignored', () => {
        const note = parseNote({vaultRoot: '/v', absolutePath: '/v/n.md', raw: '---\n: :\n---\n# Heading\n', mtime: 0});
        expect(note.frontmatter).toEqual({});
        expect(note.title).toBe('Heading');
    });
});
