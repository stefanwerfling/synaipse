import {describe, it, expect} from 'vitest';
import {apiBase, listIssues, type GiteaIssue} from '../src/GiteaApi.js';

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

const makeIssue = (n: number, overrides: Partial<GiteaIssue> = {}): GiteaIssue => ({
    id: 1000 + n,
    number: n,
    title: `Issue ${n}`,
    body: `body of ${n}`,
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

describe('GiteaApi.apiBase', () => {
    it('appends /api/v1 to a bare instance URL', () => {
        expect(apiBase('https://gitea.example.com')).toBe('https://gitea.example.com/api/v1');
    });

    it('strips a trailing slash', () => {
        expect(apiBase('https://gitea.example.com/')).toBe('https://gitea.example.com/api/v1');
    });

    it('leaves an already-suffixed URL alone', () => {
        expect(apiBase('https://gitea.example.com/api/v1')).toBe('https://gitea.example.com/api/v1');
    });
});

describe('GiteaApi.listIssues', () => {
    it('yields issues from a single page', async () => {
        const url = 'https://gitea.example.com/api/v1/repos/o/r/issues?state=open&type=issues&limit=50';
        const fetch = makeFetch({
            [url]: () => new Response(JSON.stringify([makeIssue(1), makeIssue(2)]), {status: 200})
        });

        const out: number[] = [];
        for await (const issue of listIssues('https://gitea.example.com', 'o', 'r', {fetch})) {
            out.push(issue.number);
        }
        expect(out).toEqual([1, 2]);
    });

    it('follows the "next" rel from the link header', async () => {
        const url1 = 'https://gitea.example.com/api/v1/repos/o/r/issues?state=open&type=issues&limit=50';
        const url2 = 'https://gitea.example.com/api/v1/repos/o/r/issues?state=open&type=issues&limit=50&page=2';
        const fetch = makeFetch({
            [url1]: () => new Response(JSON.stringify([makeIssue(1)]), {
                status: 200,
                headers: {link: `<${url2}>; rel="next"`}
            }),
            [url2]: () => new Response(JSON.stringify([makeIssue(2), makeIssue(3)]), {status: 200})
        });

        const out: number[] = [];
        for await (const issue of listIssues('https://gitea.example.com', 'o', 'r', {fetch})) {
            out.push(issue.number);
        }
        expect(out).toEqual([1, 2, 3]);
    });

    it('sends the Authorization header when a token is provided', async () => {
        let seenHeader: string | undefined;
        const fetch = ((async (_: string, init?: RequestInit): Promise<Response> => {
            seenHeader = (init?.headers as Record<string, string>).Authorization;
            return new Response(JSON.stringify([]), {status: 200});
        }) as unknown) as typeof globalThis.fetch;

        const gen = listIssues('https://gitea.example.com', 'o', 'r', {fetch, token: 's3cret'});
        for await (const _ of gen) { /* drain */ }
        expect(seenHeader).toBe('token s3cret');
    });

    it('omits Authorization when no token is provided', async () => {
        let seenHeader: string | undefined;
        const fetch = ((async (_: string, init?: RequestInit): Promise<Response> => {
            seenHeader = (init?.headers as Record<string, string>).Authorization;
            return new Response(JSON.stringify([]), {status: 200});
        }) as unknown) as typeof globalThis.fetch;

        for await (const _ of listIssues('https://gitea.example.com', 'o', 'r', {fetch})) { /* drain */ }
        expect(seenHeader).toBeUndefined();
    });

    it('filters out pull_request entries by default', async () => {
        const url = 'https://gitea.example.com/api/v1/repos/o/r/issues?state=open&type=issues&limit=50';
        const fetch = makeFetch({
            [url]: () => new Response(JSON.stringify([
                makeIssue(1),
                {...makeIssue(2), pull_request: {url: '...', merged: false}},
                makeIssue(3)
            ]), {status: 200})
        });

        const out: number[] = [];
        for await (const issue of listIssues('https://gitea.example.com', 'o', 'r', {fetch})) {
            out.push(issue.number);
        }
        expect(out).toEqual([1, 3]);
    });

    it('throws on non-2xx responses', async () => {
        const url = 'https://gitea.example.com/api/v1/repos/o/r/issues?state=open&type=issues&limit=50';
        const fetch = makeFetch({
            [url]: () => new Response('not found', {status: 404, statusText: 'Not Found'})
        });

        const gen = listIssues('https://gitea.example.com', 'o', 'r', {fetch});
        await expect((async () => { for await (const _ of gen) { /* drain */ } })())
            .rejects.toThrow(/Gitea 404/);
    });
});

// ── retry on transient errors (Slice 5) ────────────────────────────

describe('GiteaApi retry', () => {
    /**
     * Fetch mock that queues a sequence of responses / throws. First call
     * consumes head of the queue, second call consumes the next, etc.
     * Tracks how many times fetch was invoked in `calls`.
     */
    const queuedFetch = (queue: Array<() => Response | Promise<Response>>): {
        fetch: typeof fetch;
        calls: {count: number};
    } => {
        const calls = {count: 0};
        const fn = (async (): Promise<Response> => {
            const handler = queue[calls.count++];
            if (handler === undefined) throw new Error('queue exhausted');
            return handler();
        }) as unknown as typeof fetch;
        return {fetch: fn, calls};
    };

    // A network-error look-alike. undici's real "fetch failed" is a
    // TypeError; that's what our classifier matches on.
    const networkError = (): never => {
        throw new TypeError('fetch failed');
    };

    it('retries a transient network error and eventually succeeds', async () => {
        const {fetch, calls} = queuedFetch([
            networkError,
            () => new Response(JSON.stringify([makeIssue(1)]), {status: 200})
        ]);

        const out: number[] = [];
        for await (const issue of listIssues('https://gitea.example.com', 'o', 'r', {fetch})) {
            out.push(issue.number);
        }

        expect(out).toEqual([1]);
        expect(calls.count).toBe(2);
    }, 10_000);

    it('retries a 503 upstream error and eventually succeeds', async () => {
        const {fetch, calls} = queuedFetch([
            () => new Response('gateway timeout', {status: 503}),
            () => new Response(JSON.stringify([makeIssue(2)]), {status: 200})
        ]);

        const out: number[] = [];
        for await (const issue of listIssues('https://gitea.example.com', 'o', 'r', {fetch})) {
            out.push(issue.number);
        }

        expect(out).toEqual([2]);
        expect(calls.count).toBe(2);
    }, 10_000);

    it('does not retry an AbortError (caller cancelled)', async () => {
        const {fetch, calls} = queuedFetch([
            () => { const err = new Error('aborted'); err.name = 'AbortError'; throw err; }
        ]);

        const gen = listIssues('https://gitea.example.com', 'o', 'r', {fetch});
        await expect((async () => { for await (const _ of gen) { /* drain */ } })())
            .rejects.toThrow();

        expect(calls.count).toBe(1);
    });

    it('does not retry a 4xx client error like 404', async () => {
        const {fetch, calls} = queuedFetch([
            () => new Response('not found', {status: 404})
        ]);

        const gen = listIssues('https://gitea.example.com', 'o', 'r', {fetch});
        await expect((async () => { for await (const _ of gen) { /* drain */ } })())
            .rejects.toThrow(/Gitea 404/);

        expect(calls.count).toBe(1);
    });
});