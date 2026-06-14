import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, readFile, stat} from 'node:fs/promises';
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

interface Handler {
    body: () => Buffer | string | object;
    contentType?: string;
    status?: number;
}

const makeFetch = (handlers: Record<string, Handler | (() => Response)>): typeof fetch => {
    return (async (url: string | URL | Request): Promise<Response> => {
        const key = typeof url === 'string' ? url : url.toString();
        const handler = handlers[key];

        if (handler === undefined) {
            throw new Error(`unexpected fetch: ${key}`);
        }

        if (typeof handler === 'function') {
            return handler();
        }

        const status = handler.status ?? 200;
        const body = handler.body();

        if (body instanceof Buffer) {
            return new Response(body, {
                status,
                headers: handler.contentType ? {'content-type': handler.contentType} : {}
            });
        }

        if (typeof body === 'string') {
            return new Response(body, {
                status,
                headers: handler.contentType ? {'content-type': handler.contentType} : {}
            });
        }

        return new Response(JSON.stringify(body), {
            status,
            headers: {'content-type': 'application/json'}
        });
    }) as typeof fetch;
};

const jsonResponse = (body: unknown): Response => {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {'content-type': 'application/json'}
    });
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic bytes

describe('DevToCrawler', () => {
    it('writes one folder per article with article.md and the id in path + frontmatter', async () => {
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

        const crawler = new DevToCrawler({apiKey: 'fake', downloadImages: false, fetch: fakeFetch});
        const report = await crawler.run({vault, log: () => undefined});

        expect(report.fetched).toBe(1);
        expect(report.written).toBe(1);
        expect(report.errors).toEqual([]);

        const note = vault.tryGet('Crawler/devto/articles/1234-why-typescript-is-great-1abc/article.md');
        expect(note).toBeDefined();
        expect(note!.title).toBe('Why TypeScript is great');
        expect(note!.frontmatter.articleId).toBe(1234);
        expect(note!.content).toContain('Article `1234`');
        expect(note!.content).toContain('article body about types');

        const index = vault.tryGet('Crawler/devto/articles/_index.md');
        expect(index).toBeDefined();
        expect(index!.content).toContain('[[Why TypeScript is great]]');
    });

    it('downloads inline images and rewrites the markdown to local paths', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const imgUrl = 'https://media2.dev.to/uploads/diagram.png';
        const listItem = makeListItem();

        const fakeFetch = makeFetch({
            'https://dev.to/api/articles/latest?per_page=100': {body: () => [listItem]},
            'https://dev.to/api/articles/1234': {body: () => ({
                ...listItem,
                body_markdown: `# Heading\n\nLook:\n\n![Diagram](${imgUrl})\n\nDone.`
            })},
            [imgUrl]: {body: () => PNG, contentType: 'image/png'}
        });

        const crawler = new DevToCrawler({apiKey: 'fake', fetch: fakeFetch});
        const report = await crawler.run({vault, log: () => undefined});

        expect(report.errors).toEqual([]);

        const note = vault.tryGet('Crawler/devto/articles/1234-why-typescript-is-great-1abc/article.md');
        expect(note!.content).toMatch(/!\[Diagram\]\(\.\/img-[0-9a-f]{12}\.png\)/);
        expect(note!.content).not.toContain(imgUrl);

        const folder = path.join(vaultDir, 'Crawler/devto/articles/1234-why-typescript-is-great-1abc');
        const localMatch = note!.content.match(/\.\/(img-[0-9a-f]{12}\.png)/);
        expect(localMatch).not.toBeNull();
        const info = await stat(path.join(folder, localMatch![1]!));
        expect(info.size).toBeGreaterThan(0);
        const onDisk = await readFile(path.join(folder, localMatch![1]!));
        expect(onDisk.equals(PNG)).toBe(true);
    });

    it('downloads the cover image and rewrites coverImage in frontmatter', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const coverUrl = 'https://media2.dev.to/covers/123.jpg';
        const listItem = makeListItem({cover_image: coverUrl});

        const fakeFetch = makeFetch({
            'https://dev.to/api/articles/latest?per_page=100': {body: () => [listItem]},
            'https://dev.to/api/articles/1234': {body: () => ({...listItem, body_markdown: '# x'})},
            [coverUrl]: {body: () => PNG, contentType: 'image/jpeg'}
        });

        const crawler = new DevToCrawler({apiKey: 'fake', fetch: fakeFetch});
        await crawler.run({vault, log: () => undefined});

        const note = vault.tryGet('Crawler/devto/articles/1234-why-typescript-is-great-1abc/article.md');
        expect(note!.frontmatter.coverImage).toMatch(/^\.\/img-[0-9a-f]{12}\.jpg$/);
    });

    it('cache-hits an existing image file on a second run (no re-download)', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const imgUrl = 'https://media2.dev.to/uploads/cache.png';
        const listItem = makeListItem();
        let imageHits = 0;

        const fakeFetch = makeFetch({
            'https://dev.to/api/articles/latest?per_page=100': {body: () => [listItem]},
            'https://dev.to/api/articles/1234': {body: () => ({
                ...listItem,
                body_markdown: `![](${imgUrl})`
            })},
            [imgUrl]: () => {
                imageHits += 1;
                return new Response(PNG, {status: 200, headers: {'content-type': 'image/png'}});
            }
        });

        const crawler = new DevToCrawler({apiKey: 'fake', fetch: fakeFetch});
        await crawler.run({vault, log: () => undefined});
        await crawler.run({vault, log: () => undefined});

        expect(imageHits).toBe(1);
    });

    it('continues past image download failures', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const goodUrl = 'https://media2.dev.to/ok.png';
        const badUrl = 'https://media2.dev.to/broken.png';
        const listItem = makeListItem();

        const fakeFetch = makeFetch({
            'https://dev.to/api/articles/latest?per_page=100': {body: () => [listItem]},
            'https://dev.to/api/articles/1234': {body: () => ({
                ...listItem,
                body_markdown: `![ok](${goodUrl}) ![bad](${badUrl})`
            })},
            [goodUrl]: {body: () => PNG, contentType: 'image/png'},
            [badUrl]: {body: () => 'nope', status: 500}
        });

        const crawler = new DevToCrawler({apiKey: 'fake', fetch: fakeFetch});
        const report = await crawler.run({vault, log: () => undefined});

        expect(report.errors.some((e) => e.item.includes('broken.png'))).toBe(true);
        const note = vault.tryGet('Crawler/devto/articles/1234-why-typescript-is-great-1abc/article.md');
        expect(note!.content).toContain(badUrl);                  // unchanged URL stays
        expect(note!.content).toMatch(/!\[ok\]\(\.\/img-[0-9a-f]{12}\.png\)/);
    });

    it('skips downloads entirely when downloadImages is false', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const imgUrl = 'https://media2.dev.to/skip.png';
        const listItem = makeListItem({cover_image: imgUrl});

        const fakeFetch = makeFetch({
            'https://dev.to/api/articles/latest?per_page=100': {body: () => [listItem]},
            'https://dev.to/api/articles/1234': {body: () => ({
                ...listItem,
                body_markdown: `![x](${imgUrl})`
            })}
            // notably no handler for the image URL
        });

        const crawler = new DevToCrawler({apiKey: 'fake', downloadImages: false, fetch: fakeFetch});
        const report = await crawler.run({vault, log: () => undefined});

        expect(report.errors).toEqual([]);
        const note = vault.tryGet('Crawler/devto/articles/1234-why-typescript-is-great-1abc/article.md');
        expect(note!.content).toContain(imgUrl);
        expect(note!.frontmatter.coverImage).toBe(imgUrl);
    });
});