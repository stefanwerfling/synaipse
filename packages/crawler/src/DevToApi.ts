export interface DevToUser {
    name?: string;
    username: string;
    profile_image?: string;
}

export interface DevToOrganization {
    name: string;
    username: string;
}

export interface DevToArticleListItem {
    id: number;
    title: string;
    description: string;
    slug: string;
    path: string;
    url: string;
    canonical_url: string;
    cover_image: string | null;
    published_at: string;
    edited_at?: string | null;
    last_comment_at?: string;
    tag_list: string[];
    tags: string;
    reading_time_minutes: number;
    public_reactions_count: number;
    comments_count: number;
    positive_reactions_count: number;
    user: DevToUser;
    organization?: DevToOrganization | null;
}

export interface DevToArticle extends DevToArticleListItem {
    body_markdown?: string;
    body_html?: string;
}

const API_BASE = 'https://dev.to/api';

const buildHeaders = (apiKey: string): Record<string, string> => ({
    'api-key': apiKey,
    Accept: 'application/vnd.forem.api-v1+json',
    'User-Agent': 'synaipse-crawler'
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface FetchOptions {
    fetch?: typeof fetch;
    log?: (line: string) => void;
}

const callJson = async <T>(url: string, apiKey: string, opts: FetchOptions): Promise<T> => {
    const f = opts.fetch ?? fetch;

    let attempt = 0;

    while (true) {
        const response = await f(url, {headers: buildHeaders(apiKey)});

        if (response.status === 429) {
            const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '0', 10);

            if (retryAfter > 0 && attempt < 5) {
                opts.log?.(`[dev.to] 429 — retrying in ${retryAfter}s`);
                await sleep(retryAfter * 1000);
                attempt += 1;
                continue;
            }
        }

        if (!response.ok) {
            throw new Error(`dev.to ${response.status} for ${url}: ${await response.text()}`);
        }

        return response.json() as Promise<T>;
    }
};

export const listLatestArticles = async (
    apiKey: string,
    perPage: number,
    opts: FetchOptions = {}
): Promise<DevToArticleListItem[]> => {
    const url = `${API_BASE}/articles/latest?per_page=${Math.min(perPage, 1000)}`;
    return callJson<DevToArticleListItem[]>(url, apiKey, opts);
};

export const getArticle = async (
    apiKey: string,
    id: number,
    opts: FetchOptions = {}
): Promise<DevToArticle> => {
    return callJson<DevToArticle>(`${API_BASE}/articles/${id}`, apiKey, opts);
};