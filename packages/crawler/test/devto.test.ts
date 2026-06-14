import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Vault} from '@synaipse/vault';
import {DevToCrawler} from '../src/DevTo.js';

let vaultDir: string;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'crawler-devto-'));
});

afterEach(async () => {
    await rm(vaultDir, {recursive: true, force: true});
});

const makeListItem = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 1234,
    title: 'Why TypeScript is great',
    description: 'A small love letter to TS',
    slug: 'why-typescript-is-great-1abc',
    path: '/alice/why-typescript-is-great-1abc',
    url: 'https://dev.to/alice/why-typescript-is-great-1abc',
    canonical_url: 'https://dev.to/alice/why-typescript-is-great-1abc',
    cover_image: null,
    published_at: '2026-06-14T10:00:00Z',
    edited_at: null,
    tag_list: ['typescript', 'webdev'],
    tags: 'typescript, webdev',
    reading_time_minutes: 4,
    public_reactions_count: 99,
    comments_count: 12,
    positive_reactions_count: 99,
    user: {name: 'Alice Wonderland', username: 'alice'},
    organization: null,
    ...overrides
});

const makeFetch = (handlers: Record<string, () => Response>): typeof fetch => {
    return (async (url: string | URL | Request): Promise<Response> => {
        const key = typeof url === 'string' ? url : url.toString();
        const handler = handlers[key];

        if (handler === undefined) {
            throw new Error(`unexpected fetch: ${key}`);
        }

        return handler();
    }) as typeof fetch;
};

const jsonResponse = (body: unknown): Response => {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {'content-type': 'application/json'}
    });
};

describe('DevToCrawler', () => {
    it('writes a note per article with article id in path + frontmatter, plus _index.md', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const listItem = makeListItem();
        const fakeFetch = makeFetch({
            'https://dev.to/api/articles/latest?per_page=100': () => jsonResponse([listItem]),
            'https://dev.to/api/articles/1234': () => jsonResponse({
                ...listItem,
                body_markdown: '# Hello\n\nThis is the article body about types.'
            })
        });

        const crawler = new DevToCrawler({apiKey: 'fake', fetch: fakeFetch});
        const report = await crawler.run({vault, log: () => undefined});

        expect(report.fetched).toBe(1);
        expect(report.written).toBe(1);
        expect(report.errors).toEqual([]);

        const note = vault.tryGet('Crawler/devto/articles/1234-why-typescript-is-great-1abc.md');
        expect(note).toBeDefined();
        expect(note!.title).toBe('Why TypeScript is great');
        expect(note!.frontmatter.type).toBe('external');
        expect(note!.frontmatter.source).toBe('devto');
        expect(note!.frontmatter.articleId).toBe(1234);
        expect(note!.frontmatter.author).toBe('alice');
        expect(note!.tags).toEqual(expect.arrayContaining(['crawler', 'devto', 'tag/typescript', 'tag/webdev']));
        expect(note!.content).toContain('Article `1234`');
        expect(note!.content).toContain('Indexed in [[Dev.to — latest articles]]');
        expect(note!.content).toContain('article body about types');

        const index = vault.tryGet('Crawler/devto/articles/_index.md');
        expect(index).toBeDefined();
        expect(index!.content).toContain('1 articles crawled');
        expect(index!.content).toContain('[[Why TypeScript is great]]');
        expect(index!.content).toContain('`#1234`');
        expect(index!.frontmatter.totalArticles).toBe(1);
    });

    it('skips the per-article body fetch when bodyMax is 0', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const listItem = makeListItem();
        const fakeFetch = makeFetch({
            'https://dev.to/api/articles/latest?per_page=100': () => jsonResponse([listItem])
            // notably no /articles/1234 handler — the test fails if we call it
        });

        const crawler = new DevToCrawler({apiKey: 'fake', bodyMax: 0, fetch: fakeFetch});
        const report = await crawler.run({vault, log: () => undefined});

        expect(report.errors).toEqual([]);
        const note = vault.tryGet('Crawler/devto/articles/1234-why-typescript-is-great-1abc.md');
        expect(note!.content).not.toContain('## Body');
        expect(note!.content).toContain('Article `1234`');
    });

    it('truncates a long body to bodyMax', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const listItem = makeListItem();
        const longBody = 'B'.repeat(7000);
        const fakeFetch = makeFetch({
            'https://dev.to/api/articles/latest?per_page=100': () => jsonResponse([listItem]),
            'https://dev.to/api/articles/1234': () => jsonResponse({...listItem, body_markdown: longBody})
        });

        const crawler = new DevToCrawler({apiKey: 'fake', bodyMax: 500, fetch: fakeFetch});
        await crawler.run({vault, log: () => undefined});

        const note = vault.tryGet('Crawler/devto/articles/1234-why-typescript-is-great-1abc.md');
        expect(note!.content).toContain('…(truncated)');
    });

    it('counts unchanged on a repeated run with identical content', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const listItem = makeListItem();
        const baseHandlers = {
            'https://dev.to/api/articles/latest?per_page=100': () => jsonResponse([listItem]),
            'https://dev.to/api/articles/1234': () => jsonResponse({...listItem, body_markdown: '# stable'})
        };

        const crawler = new DevToCrawler({apiKey: 'fake', fetch: makeFetch(baseHandlers)});

        const first = await crawler.run({vault, log: () => undefined});
        expect(first.written).toBe(1);

        const second = await crawler.run({vault, log: () => undefined});
        expect(second.unchanged).toBe(1);
        expect(second.written).toBe(0);
    });

    it('continues past per-article fetch failures', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const ok = makeListItem({id: 1, slug: 'ok'});
        const broken = makeListItem({id: 2, slug: 'broken', title: 'Broken'});

        const fakeFetch = makeFetch({
            'https://dev.to/api/articles/latest?per_page=100': () => jsonResponse([ok, broken]),
            'https://dev.to/api/articles/1': () => jsonResponse({...ok, body_markdown: '# ok'}),
            'https://dev.to/api/articles/2': () => new Response('boom', {status: 500})
        });

        const crawler = new DevToCrawler({apiKey: 'fake', fetch: fakeFetch});
        const report = await crawler.run({vault, log: () => undefined});

        expect(report.errors.length).toBe(1);
        expect(report.errors[0]?.item).toContain('#2');
        expect(vault.tryGet('Crawler/devto/articles/1-ok.md')).toBeDefined();
        expect(vault.tryGet('Crawler/devto/articles/_index.md')).toBeDefined();
    });
});