import {describe, it, expect, beforeEach} from 'vitest';
import type {Note, NoteId, NoteWriteInput} from '@synaipse/core';
import {GiteaIssuesCrawler} from '../src/GiteaIssues.js';
import type {GiteaIssue} from '../src/GiteaApi.js';

const makeIssue = (n: number, overrides: Partial<GiteaIssue> = {}): GiteaIssue => ({
    id: 1000 + n,
    number: n,
    title: `Fix the ${n}`,
    body: `body body ${n}`,
    state: 'open',
    user: {id: 1, login: 'alice'},
    assignees: null,
    labels: [],
    milestone: null,
    html_url: `https://gitea.example.com/o/r/issues/${n}`,
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-02T10:00:00Z',
    closed_at: null,
    comments: 0,
    ...overrides
});

const singlePageFetch = (issues: GiteaIssue[]): typeof fetch =>
    (async () => new Response(JSON.stringify(issues), {status: 200})) as unknown as typeof fetch;

interface CapturedWrite {
    path: string;
    content: string;
    frontmatter: Record<string, unknown>;
}

/**
 * Minimal in-memory fake vault side used by the crawler tests. Records
 * every write and can return a Note-shaped record on tryRead so the
 * idempotency + consent-preservation paths are exercisable without
 * the full FilesystemNoteAdapter + Vault stack.
 */
const makeDeps = (): {
    deps: Parameters<GiteaIssuesCrawler['run']>[0];
    writes: CapturedWrite[];
    logs: string[];
    seed: (id: NoteId, frontmatter: Record<string, unknown>) => void;
} => {
    const writes: CapturedWrite[] = [];
    const logs: string[] = [];
    const store = new Map<NoteId, Note>();

    return {
        writes,
        logs,
        seed: (id, frontmatter) => {
            store.set(id, {
                id,
                path: `/tmp/${id}`,
                title: (frontmatter.title as string) ?? id,
                content: 'seeded',
                frontmatter: frontmatter as Note['frontmatter'],
                tags: [],
                wikilinks: [],
                backlinks: [],
                mtime: 0,
                hash: 'seed'
            });
        },
        deps: {
            log: (line) => logs.push(line),
            tryRead: (id) => store.get(id),
            write: async (input: NoteWriteInput) => {
                writes.push({
                    path: input.path,
                    content: input.content,
                    frontmatter: (input.frontmatter ?? {}) as Record<string, unknown>
                });
                // Mirror the write into the store so a *second* run's
                // tryRead sees the freshly-written note.
                store.set(input.path as NoteId, {
                    id: input.path as NoteId,
                    path: `/tmp/${input.path}`,
                    title: (input.frontmatter?.title as string) ?? input.path,
                    content: input.content,
                    frontmatter: (input.frontmatter ?? {}) as Note['frontmatter'],
                    tags: [],
                    wikilinks: [],
                    backlinks: [],
                    mtime: Date.now(),
                    hash: `h${writes.length}`
                });
                return store.get(input.path as NoteId) as Note;
            }
        }
    };
};

describe('GiteaIssuesCrawler', () => {
    let ctx: ReturnType<typeof makeDeps>;

    beforeEach(() => {
        ctx = makeDeps();
    });

    it('writes each issue under Crawler/Gitea/<project>/ with mcp_consent: pending', async () => {
        const crawler = new GiteaIssuesCrawler({
            baseUrl: 'https://gitea.example.com',
            owner: 'o',
            repo: 'r',
            project: 'myproj',
            fetch: singlePageFetch([makeIssue(1), makeIssue(2)])
        });

        const report = await crawler.run(ctx.deps);

        expect(report.fetched).toBe(2);
        expect(report.written).toBe(2);
        expect(ctx.writes).toHaveLength(2);

        expect(ctx.writes[0]?.path).toBe('Crawler/Gitea/myproj/issue-1-fix-the-1.md');
        expect(ctx.writes[0]?.frontmatter.mcp_consent).toBe('pending');
        expect(ctx.writes[0]?.frontmatter.project).toBe('myproj');
        expect(ctx.writes[0]?.frontmatter.source).toBe('gitea');
        expect(ctx.writes[0]?.frontmatter.source_url).toBe('https://gitea.example.com/o/r/issues/1');
    });

    it('emits an open-checkbox todo line so synaipse_todos surfaces the issue', async () => {
        const crawler = new GiteaIssuesCrawler({
            baseUrl: 'https://gitea.example.com',
            owner: 'o',
            repo: 'r',
            project: 'p',
            fetch: singlePageFetch([makeIssue(7, {title: 'Refactor Foo'})])
        });

        await crawler.run(ctx.deps);
        expect(ctx.writes[0]?.content).toContain('- [ ] Refactor Foo');
    });

    it('closed issues become a done checkbox', async () => {
        const crawler = new GiteaIssuesCrawler({
            baseUrl: 'https://gitea.example.com',
            owner: 'o',
            repo: 'r',
            project: 'p',
            state: 'closed',
            fetch: singlePageFetch([makeIssue(4, {
                state: 'closed',
                closed_at: '2026-07-05T00:00:00Z',
                title: 'Ship it'
            })])
        });

        await crawler.run(ctx.deps);
        expect(ctx.writes[0]?.content).toContain('- [x] Ship it');
    });

    it('skips writing when gitea_updated_at is unchanged (idempotency)', async () => {
        const issue = makeIssue(9);
        ctx.seed('Crawler/Gitea/p/issue-9-fix-the-9.md', {
            gitea_updated_at: issue.updated_at,
            mcp_consent: 'pending'
        });

        const crawler = new GiteaIssuesCrawler({
            baseUrl: 'https://gitea.example.com',
            owner: 'o',
            repo: 'r',
            project: 'p',
            fetch: singlePageFetch([issue])
        });

        const report = await crawler.run(ctx.deps);
        expect(report.written).toBe(0);
        expect(report.unchanged).toBe(1);
        expect(ctx.writes).toHaveLength(0);
    });

    it('preserves a previous mcp_consent: granted decision on refresh', async () => {
        const issue = makeIssue(5, {updated_at: '2026-07-08T00:00:00Z'});
        ctx.seed('Crawler/Gitea/p/issue-5-fix-the-5.md', {
            gitea_updated_at: '2026-07-01T00:00:00Z',  // stale — will trigger a rewrite
            mcp_consent: 'granted',
            mcp_consent_at: '2026-07-03T12:00:00Z'
        });

        const crawler = new GiteaIssuesCrawler({
            baseUrl: 'https://gitea.example.com',
            owner: 'o',
            repo: 'r',
            project: 'p',
            fetch: singlePageFetch([issue])
        });

        await crawler.run(ctx.deps);
        expect(ctx.writes[0]?.frontmatter.mcp_consent).toBe('granted');
        expect(ctx.writes[0]?.frontmatter.mcp_consent_at).toBe('2026-07-03T12:00:00Z');
    });

    it('preserves a previous mcp_consent: denied decision on refresh', async () => {
        const issue = makeIssue(6, {updated_at: '2026-07-08T00:00:00Z'});
        ctx.seed('Crawler/Gitea/p/issue-6-fix-the-6.md', {
            gitea_updated_at: '2026-07-01T00:00:00Z',
            mcp_consent: 'denied'
        });

        const crawler = new GiteaIssuesCrawler({
            baseUrl: 'https://gitea.example.com',
            owner: 'o',
            repo: 'r',
            project: 'p',
            fetch: singlePageFetch([issue])
        });

        await crawler.run(ctx.deps);
        expect(ctx.writes[0]?.frontmatter.mcp_consent).toBe('denied');
    });

    it('tags the note with crawler + gitea + issue + state/<state>', async () => {
        const crawler = new GiteaIssuesCrawler({
            baseUrl: 'https://gitea.example.com',
            owner: 'o',
            repo: 'r',
            project: 'p',
            fetch: singlePageFetch([makeIssue(1)])
        });

        await crawler.run(ctx.deps);
        const tags = ctx.writes[0]?.frontmatter.tags as string[];
        expect(tags).toContain('crawler');
        expect(tags).toContain('gitea');
        expect(tags).toContain('issue');
        expect(tags).toContain('state/open');
    });

    it('reports errors instead of throwing when the top-level fetch fails', async () => {
        const crawler = new GiteaIssuesCrawler({
            baseUrl: 'https://gitea.example.com',
            owner: 'o',
            repo: 'r',
            project: 'p',
            fetch: (async () => new Response('nope', {status: 500, statusText: 'Server Error'})) as unknown as typeof fetch
        });

        const report = await crawler.run(ctx.deps);
        expect(report.fetched).toBe(0);
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]?.item).toBe('o/r');
    });

    it('honours a custom pathPrefix', async () => {
        const crawler = new GiteaIssuesCrawler({
            baseUrl: 'https://gitea.example.com',
            owner: 'o',
            repo: 'r',
            project: 'p',
            pathPrefix: 'Custom/Location',
            fetch: singlePageFetch([makeIssue(1)])
        });

        await crawler.run(ctx.deps);
        expect(ctx.writes[0]?.path).toBe('Custom/Location/issue-1-fix-the-1.md');
    });

    // ── delta refresh (Slice 5) ────────────────────────────────────

    /**
     * Capture-fetch: records every URL requested and returns the given
     * static issue payload. Used to verify the crawler passes the
     * expected `since` query param.
     */
    const captureFetch = (issues: GiteaIssue[]): {fetch: typeof fetch; urls: string[]} => {
        const urls: string[] = [];
        const fn = (async (input: string | URL | Request) => {
            urls.push(String(input));
            return new Response(JSON.stringify(issues), {status: 200});
        }) as unknown as typeof fetch;
        return {fetch: fn, urls};
    };

    it('infers since from max gitea_updated_at across existing notes', async () => {
        // Seed three notes with varying timestamps — the crawler should
        // pick the latest as its `since` cutoff.
        ctx.seed('Crawler/Gitea/p/issue-1-fix-the-1.md', {
            gitea_updated_at: '2026-07-01T10:00:00Z'
        });
        ctx.seed('Crawler/Gitea/p/issue-2-fix-the-2.md', {
            gitea_updated_at: '2026-07-05T10:00:00Z'  // max
        });
        ctx.seed('Crawler/Gitea/p/issue-3-fix-the-3.md', {
            gitea_updated_at: '2026-07-03T10:00:00Z'
        });

        // Extend deps with listNotesUnder — returns anything under prefix.
        const store = new Map<string, Note>();
        (ctx as unknown as {seedStore?: Map<string, Note>}).seedStore = store;

        const {fetch: cap, urls} = captureFetch([]);

        // Rebuild deps with listNotesUnder so the crawler can walk them.
        const seededNotes: Note[] = [];
        ctx.seed = ((id: NoteId, frontmatter: Record<string, unknown>) => {
            const note: Note = {
                id, path: `/tmp/${id}`, title: id,
                content: '', frontmatter: frontmatter as Note['frontmatter'],
                tags: [], wikilinks: [], backlinks: [], mtime: 0, hash: 'seed'
            };
            seededNotes.push(note);
        }) as typeof ctx.seed;
        ctx.seed('Crawler/Gitea/p/issue-1-fix-the-1.md', {gitea_updated_at: '2026-07-01T10:00:00Z'});
        ctx.seed('Crawler/Gitea/p/issue-2-fix-the-2.md', {gitea_updated_at: '2026-07-05T10:00:00Z'});
        ctx.seed('Crawler/Gitea/p/issue-3-fix-the-3.md', {gitea_updated_at: '2026-07-03T10:00:00Z'});

        const deps: Parameters<GiteaIssuesCrawler['run']>[0] = {
            log: (line) => ctx.logs.push(line),
            tryRead: () => undefined,
            write: ctx.deps.write,
            listNotesUnder: (prefix) => seededNotes.filter((n) => n.id.startsWith(prefix))
        };

        const crawler = new GiteaIssuesCrawler({
            baseUrl: 'https://gitea.example.com',
            owner: 'o', repo: 'r', project: 'p',
            fetch: cap
        });

        await crawler.run(deps);
        expect(urls).toHaveLength(1);
        expect(urls[0]).toContain('since=2026-07-05T10%3A00%3A00Z');
        expect(ctx.logs.join('\n')).toContain('delta-refresh from 2026-07-05T10:00:00Z');
    });

    it('respects an explicit since override even when notes exist', async () => {
        const seededNotes: Note[] = [{
            id: 'Crawler/Gitea/p/issue-99-x.md' as NoteId,
            path: '/tmp/x', title: 'x', content: '',
            frontmatter: {gitea_updated_at: '2026-07-05T00:00:00Z'} as Note['frontmatter'],
            tags: [], wikilinks: [], backlinks: [], mtime: 0, hash: 'x'
        }];

        const {fetch: cap, urls} = captureFetch([]);
        const crawler = new GiteaIssuesCrawler({
            baseUrl: 'https://gitea.example.com',
            owner: 'o', repo: 'r', project: 'p',
            since: '2026-06-01T00:00:00Z',
            fetch: cap
        });

        await crawler.run({
            log: () => undefined,
            tryRead: () => undefined,
            write: ctx.deps.write,
            listNotesUnder: () => seededNotes
        });

        expect(urls[0]).toContain('since=2026-06-01T00%3A00%3A00Z');
        expect(urls[0]).not.toContain('since=2026-07-05');
    });

    it('does no since inference when no notes exist under the prefix', async () => {
        const {fetch: cap, urls} = captureFetch([]);
        const crawler = new GiteaIssuesCrawler({
            baseUrl: 'https://gitea.example.com',
            owner: 'o', repo: 'r', project: 'p',
            fetch: cap
        });

        await crawler.run({
            log: () => undefined,
            tryRead: () => undefined,
            write: ctx.deps.write,
            listNotesUnder: () => []
        });

        expect(urls[0]).not.toContain('since=');
    });
});