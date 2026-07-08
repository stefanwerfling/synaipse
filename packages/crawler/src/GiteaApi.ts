/**
 * Minimal Gitea REST-API v1 client. Read-only surface (we never
 * mutate the remote); scoped to what the issues crawler needs today:
 * repo metadata + paginated issues.
 *
 * Docs: https://docs.gitea.com/api — matches Gitea >= 1.20. The shape
 * is intentionally close to the raw JSON response (`snake_case` where
 * the API uses it) so future extensions don't need remapping. Fields
 * we don't consume yet are omitted rather than typed-as-unknown to
 * keep the types honest about what we actually read.
 */

export interface GiteaUser {
    id: number;
    login: string;
    full_name?: string;
    email?: string;
    avatar_url?: string;
}

export interface GiteaLabel {
    id: number;
    name: string;
    color: string;
    description?: string;
}

export interface GiteaMilestone {
    id: number;
    title: string;
    description?: string;
    state: 'open' | 'closed';
    due_on?: string;
}

export interface GiteaIssue {
    id: number;
    /** The per-repo issue number shown in the UI (`#42`). */
    number: number;
    title: string;
    body: string;
    state: 'open' | 'closed';
    user: GiteaUser;
    assignees: GiteaUser[] | null;
    labels: GiteaLabel[];
    milestone: GiteaMilestone | null;
    html_url: string;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
    comments: number;
    /**
     * Gitea returns `pull_request` on issues that are actually PRs — the
     * two share IDs in the API. We use this to skip PRs unless the
     * caller opts in.
     */
    pull_request?: {url: string; merged: boolean};
}

export type GiteaIssueState = 'open' | 'closed' | 'all';

export interface GiteaAuth {
    /** Personal Access Token or application token. Omit for public repos. */
    token?: string;
}

export interface FetchOptions extends GiteaAuth {
    fetch?: typeof fetch;
    log?: (line: string) => void;
    /** AbortSignal for early cancellation by JobManager.stop. */
    signal?: AbortSignal;
}

const buildHeaders = (auth: GiteaAuth): Record<string, string> => {
    const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': 'synaipse-crawler'
    };
    if (auth.token !== undefined && auth.token.length > 0) {
        headers.Authorization = `token ${auth.token}`;
    }
    return headers;
};

const trimTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

/**
 * Normalise a base URL into a Gitea `/api/v1` prefix. Accepts either
 * the raw instance root (`https://gitea.example.com`) or the API root
 * with `/api/v1` already appended — both are common in the wild.
 */
export const apiBase = (baseUrl: string): string => {
    const trimmed = trimTrailingSlash(baseUrl);
    if (trimmed.endsWith('/api/v1')) return trimmed;
    return `${trimmed}/api/v1`;
};

const respectRateLimit = async (response: Response, log?: (line: string) => void): Promise<void> => {
    // Gitea exposes standard `x-ratelimit-*` headers. Non-authenticated
    // requests carry lower quotas but the header shape is the same.
    const remaining = Number.parseInt(response.headers.get('x-ratelimit-remaining') ?? '999', 10);
    if (remaining > 1) return;

    const reset = Number.parseInt(response.headers.get('x-ratelimit-reset') ?? '0', 10);
    if (reset <= 0) return;

    const waitMs = Math.max(0, reset * 1000 - Date.now()) + 500;
    if (waitMs > 0) {
        log?.(`[gitea] rate limit reached — waiting ${Math.ceil(waitMs / 1000)}s until reset`);
        await new Promise((r) => setTimeout(r, waitMs));
    }
};

const gtFetch = async (
    url: string,
    auth: GiteaAuth,
    opts: FetchOptions
): Promise<Response> => {
    const f = opts.fetch ?? fetch;
    let attempt = 0;

    while (true) {
        if (opts.signal?.aborted === true) {
            throw new Error('aborted');
        }

        const response = await f(url, {
            headers: buildHeaders(auth),
            ...(opts.signal !== undefined ? {signal: opts.signal} : {})
        });

        if (response.status === 429 || response.status === 403) {
            const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '0', 10);

            if (retryAfter > 0 && attempt < 5) {
                opts.log?.(`[gitea] ${response.status} — retrying in ${retryAfter}s`);
                await new Promise((r) => setTimeout(r, retryAfter * 1000));
                attempt += 1;
                continue;
            }
        }

        await respectRateLimit(response, opts.log);
        return response;
    }
};

/**
 * Read the `link` header (RFC 5988) and pick the URL flagged `rel="next"`.
 * Gitea emits the same format as GitHub, so this mirrors the GitHub
 * client's helper.
 */
const parseLinkNext = (header: string | null): string | null => {
    if (header === null) return null;

    for (const part of header.split(',')) {
        const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
        if (match !== null && match[2] === 'next' && match[1] !== undefined) {
            return match[1];
        }
    }
    return null;
};

const callJson = async <T>(url: string, opts: FetchOptions): Promise<T> => {
    const response = await gtFetch(url, opts, opts);

    if (!response.ok) {
        throw new Error(`Gitea ${response.status} ${response.statusText} for ${url}: ${await response.text()}`);
    }

    return response.json() as Promise<T>;
};

export interface ListIssuesOptions extends FetchOptions {
    state?: GiteaIssueState;
    /**
     * If true, PR entries are yielded alongside regular issues. Default
     * false — for the todo-flow we only want issues.
     */
    includePullRequests?: boolean;
    /** Filter issues updated on/after this ISO timestamp (Gitea `since` param). */
    since?: string;
    perPage?: number;
}

export const listIssues = async function* (
    baseUrl: string,
    owner: string,
    repo: string,
    opts: ListIssuesOptions = {}
): AsyncGenerator<GiteaIssue> {
    const state = opts.state ?? 'open';
    const perPage = opts.perPage ?? 50;
    const params = new URLSearchParams({
        state,
        type: 'issues',   // Gitea >= 1.20 supports this to exclude PRs at the source
        limit: String(perPage)
    });

    if (opts.since !== undefined) params.set('since', opts.since);

    let url: string | null =
        `${apiBase(baseUrl)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params.toString()}`;

    while (url !== null) {
        const response = await gtFetch(url, opts, opts);

        if (!response.ok) {
            throw new Error(`Gitea ${response.status} for ${url}: ${await response.text()}`);
        }

        const page = await response.json() as GiteaIssue[];

        for (const issue of page) {
            // Belt-and-suspenders: even with `type=issues` some Gitea
            // deployments still return PRs, so filter defensively.
            if (issue.pull_request !== undefined && opts.includePullRequests !== true) {
                continue;
            }
            yield issue;
        }

        url = parseLinkNext(response.headers.get('link'));
    }
};

export interface GiteaRepo {
    id: number;
    full_name: string;
    description: string;
    html_url: string;
    private: boolean;
    default_branch: string;
    open_issues_count: number;
}

export const getRepo = async (
    baseUrl: string,
    owner: string,
    repo: string,
    opts: FetchOptions = {}
): Promise<GiteaRepo> => {
    return callJson<GiteaRepo>(
        `${apiBase(baseUrl)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        opts
    );
};