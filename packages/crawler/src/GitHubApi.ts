export interface GitHubRepoOwner {
    login: string;
}

export interface GitHubLicense {
    spdx_id: string | null;
    name: string;
}

export interface GitHubRepo {
    id: number;
    full_name: string;
    name: string;
    owner: GitHubRepoOwner;
    description: string | null;
    html_url: string;
    homepage: string | null;
    stargazers_count: number;
    watchers_count: number;
    forks_count: number;
    open_issues_count: number;
    language: string | null;
    topics: string[];
    archived: boolean;
    fork: boolean;
    license: GitHubLicense | null;
    default_branch: string;
    created_at: string;
    pushed_at: string;
    updated_at: string;
}

export interface GitHubUser {
    login: string;
}

export interface GitHubReadme {
    content: string;
    encoding: 'base64' | string;
    size: number;
}

const API_BASE = 'https://api.github.com';

const buildHeaders = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'synaipse-crawler'
});

const parseLink = (header: string | null): {next?: string} => {
    if (header === null) {
        return {};
    }

    const result: {next?: string} = {};

    for (const part of header.split(',')) {
        const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);

        if (match !== null && match[2] === 'next' && match[1] !== undefined) {
            result.next = match[1];
        }
    }

    return result;
};

const respectRateLimit = async (response: Response, log?: (line: string) => void): Promise<void> => {
    const remaining = Number.parseInt(response.headers.get('x-ratelimit-remaining') ?? '60', 10);

    if (remaining > 1) {
        return;
    }

    const reset = Number.parseInt(response.headers.get('x-ratelimit-reset') ?? '0', 10);

    if (reset <= 0) {
        return;
    }

    const waitMs = Math.max(0, reset * 1000 - Date.now()) + 500;

    if (waitMs > 0) {
        log?.(`[github] rate limit reached — waiting ${Math.ceil(waitMs / 1000)}s until reset`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
};

const ghFetch = async (
    url: string,
    token: string,
    log?: (line: string) => void
): Promise<Response> => {
    let attempt = 0;

    while (true) {
        const response = await fetch(url, {headers: buildHeaders(token)});

        if (response.status === 403 || response.status === 429) {
            const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '0', 10);

            if (retryAfter > 0) {
                log?.(`[github] ${response.status} — retrying in ${retryAfter}s`);
                await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
                attempt += 1;

                if (attempt < 5) {
                    continue;
                }
            }
        }

        await respectRateLimit(response, log);
        return response;
    }
};

export interface FetchOptions {
    fetch?: typeof fetch;
    log?: (line: string) => void;
}

const callJson = async <T>(url: string, token: string, opts: FetchOptions): Promise<T> => {
    const f = opts.fetch ?? fetch;
    const response = opts.fetch !== undefined
        ? await f(url, {headers: buildHeaders(token)})
        : await ghFetch(url, token, opts.log);

    if (!response.ok) {
        throw new Error(`GitHub ${response.status} ${response.statusText} for ${url}: ${await response.text()}`);
    }

    return response.json() as Promise<T>;
};

export const getAuthenticatedUser = async (token: string, opts: FetchOptions = {}): Promise<GitHubUser> => {
    return callJson<GitHubUser>(`${API_BASE}/user`, token, opts);
};

export const listStarredRepos = async function* (
    token: string,
    username: string,
    opts: FetchOptions = {}
): AsyncGenerator<GitHubRepo> {
    let url: string | null = `${API_BASE}/users/${encodeURIComponent(username)}/starred?per_page=100`;
    const f = opts.fetch ?? fetch;

    while (url !== null) {
        const response = opts.fetch !== undefined
            ? await f(url, {headers: buildHeaders(token)})
            : await ghFetch(url, token, opts.log);

        if (!response.ok) {
            throw new Error(`GitHub ${response.status} for ${url}: ${await response.text()}`);
        }

        const page = await response.json() as GitHubRepo[];

        for (const repo of page) {
            yield repo;
        }

        const link = parseLink(response.headers.get('link'));
        url = link.next ?? null;
    }
};

export const getReadme = async (
    token: string,
    owner: string,
    repo: string,
    opts: FetchOptions = {}
): Promise<string | null> => {
    try {
        const data = await callJson<GitHubReadme>(
            `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
            token,
            opts
        );

        if (data.encoding !== 'base64') {
            return null;
        }

        return Buffer.from(data.content, 'base64').toString('utf8');
    } catch {
        return null;
    }
};