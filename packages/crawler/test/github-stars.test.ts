import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Vault} from '@synaipse/vault';
import {GitHubStarsCrawler} from '../src/GitHubStars.js';

let vaultDir: string;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'crawler-'));
});

afterEach(async () => {
    await rm(vaultDir, {recursive: true, force: true});
});

const makeRepo = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 1,
    full_name: 'octocat/Hello-World',
    name: 'Hello-World',
    owner: {login: 'octocat'},
    description: 'A small example repo',
    html_url: 'https://github.com/octocat/Hello-World',
    homepage: null,
    stargazers_count: 1234,
    watchers_count: 1234,
    forks_count: 56,
    open_issues_count: 7,
    language: 'TypeScript',
    topics: ['demo', 'example'],
    archived: false,
    fork: false,
    license: {spdx_id: 'MIT', name: 'MIT License'},
    default_branch: 'main',
    created_at: '2020-01-01T00:00:00Z',
    pushed_at: '2025-06-01T00:00:00Z',
    updated_at: '2025-06-01T00:00:00Z',
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

const jsonResponse = (body: unknown, headers: Record<string, string> = {}): Response => {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: {'content-type': 'application/json', ...headers}
    });
};

const base64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

describe('GitHubStarsCrawler', () => {
    it('writes one note per starred repo and an _index.md', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const repo = makeRepo();

        const fakeFetch = makeFetch({
            'https://api.github.com/user': () => jsonResponse({login: 'stefan'}),
            'https://api.github.com/users/stefan/starred?per_page=100': () => jsonResponse([repo]),
            'https://api.github.com/repos/octocat/Hello-World/readme': () => jsonResponse({
                content: base64('# Hello\n\nA tiny world-greeting library.'),
                encoding: 'base64',
                size: 100
            })
        });

        const crawler = new GitHubStarsCrawler({token: 'fake', fetch: fakeFetch});
        const report = await crawler.run({vault, log: () => undefined});

        expect(report.fetched).toBe(1);
        expect(report.written).toBe(1);
        expect(report.errors).toEqual([]);

        const note = vault.tryGet('Crawler/github/starred/octocat/hello-world.md');
        expect(note).toBeDefined();
        expect(note!.title).toBe('octocat/Hello-World');
        expect(note!.frontmatter.type).toBe('external');
        expect(note!.frontmatter.source).toBe('github-stars');
        expect(note!.frontmatter.stars).toBe(1234);
        expect(note!.frontmatter.language).toBe('TypeScript');
        expect(note!.tags).toEqual(expect.arrayContaining([
            'crawler', 'github', 'language/typescript', 'topic/demo', 'topic/example'
        ]));
        expect(note!.content).toContain('world-greeting library');
        expect(note!.content).toContain('⭐ **1234**');

        const index = vault.tryGet('Crawler/github/starred/_index.md');
        expect(index).toBeDefined();
        expect(index!.content).toContain('1 repositories crawled');
        expect(index!.content).toContain('[[octocat/Hello-World]]');
        expect(index!.frontmatter.totalRepos).toBe(1);
    });

    it('uses provided username and skips the /user call', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const fakeFetch = makeFetch({
            'https://api.github.com/users/preset/starred?per_page=100': () => jsonResponse([]),
        });

        const crawler = new GitHubStarsCrawler({token: 'fake', username: 'preset', fetch: fakeFetch});
        const report = await crawler.run({vault, log: () => undefined});

        expect(report.fetched).toBe(0);
        // _index still written → ngit/disk path exercised
        expect(vault.tryGet('Crawler/github/starred/_index.md')).toBeDefined();
    });

    it('handles a missing README gracefully', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const repo = makeRepo({description: null, topics: [], language: null, license: null});

        const fakeFetch = makeFetch({
            'https://api.github.com/users/x/starred?per_page=100': () => jsonResponse([repo]),
            'https://api.github.com/repos/octocat/Hello-World/readme': () =>
                new Response('{}', {status: 404, headers: {'content-type': 'application/json'}})
        });

        const crawler = new GitHubStarsCrawler({token: 'fake', username: 'x', fetch: fakeFetch});
        const report = await crawler.run({vault, log: () => undefined});

        expect(report.errors).toEqual([]);
        const note = vault.tryGet('Crawler/github/starred/octocat/hello-world.md');
        expect(note!.content).not.toContain('## README');
    });

    it('truncates a very long README to readmeMax', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const repo = makeRepo();
        const longReadme = 'Q'.repeat(8000);

        const fakeFetch = makeFetch({
            'https://api.github.com/users/x/starred?per_page=100': () => jsonResponse([repo]),
            'https://api.github.com/repos/octocat/Hello-World/readme': () => jsonResponse({
                content: base64(longReadme),
                encoding: 'base64',
                size: longReadme.length
            })
        });

        const crawler = new GitHubStarsCrawler({token: 'fake', username: 'x', readmeMax: 500, fetch: fakeFetch});
        await crawler.run({vault, log: () => undefined});

        const note = vault.tryGet('Crawler/github/starred/octocat/hello-world.md');
        expect(note!.content).toContain('…(truncated)');
    });

    it('counts unchanged on a repeated run with identical content', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const repo = makeRepo();
        const baseHandlers = {
            'https://api.github.com/users/x/starred?per_page=100': () => jsonResponse([repo]),
            'https://api.github.com/repos/octocat/Hello-World/readme': () => jsonResponse({
                content: base64('# stable readme'),
                encoding: 'base64',
                size: 14
            })
        };

        const crawler = new GitHubStarsCrawler({token: 'fake', username: 'x', fetch: makeFetch(baseHandlers)});

        const first = await crawler.run({vault, log: () => undefined});
        expect(first.written).toBe(1);
        expect(first.unchanged).toBe(0);

        const second = await crawler.run({vault, log: () => undefined});
        expect(second.unchanged).toBe(1);
        expect(second.written).toBe(0);
    });
});