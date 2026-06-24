import type {LlmProvider} from './Llm.js';
import {INFOGRAPHIC_GUIDE} from './InfographicPrompt.js';

/**
 * Deep-research agent: takes a question → searches the web → fetches the top
 * pages → summarises the content into the LLM context → streams a cited
 * answer. Each WebSearchProvider returns up to N `{url, title, snippet?}`
 * results; we fetch the full pages ourselves and strip HTML to plain text
 * before feeding the LLM.
 */

export interface WebSearchResult {
    url: string;
    title: string;
    snippet?: string;
}

export interface WebSearchProvider {
    readonly kind: 'tavily' | 'searxng';
    search(query: string, limit: number): Promise<WebSearchResult[]>;
}

export interface ResearchSource {
    index: number;
    url: string;
    title: string;
    snippet: string;
}

export type ResearchEvent =
    | {kind: 'status'; message: string}
    | {kind: 'sources'; sources: ResearchSource[]}
    | {kind: 'token'; text: string}
    | {kind: 'done'; totalTokens: number; sources: ResearchSource[]}
    | {kind: 'error'; message: string};

export interface TavilyConfig {
    kind: 'tavily';
    apiKey: string;
    fetch?: typeof fetch;
}

export interface SearxngConfig {
    kind: 'searxng';
    url: string;
    fetch?: typeof fetch;
}

export type WebSearchConfig = TavilyConfig | SearxngConfig;

class TavilyProvider implements WebSearchProvider {
    public readonly kind = 'tavily' as const;
    private readonly apiKey: string;
    private readonly fetchImpl: typeof fetch;

    public constructor(config: TavilyConfig) {
        this.apiKey = config.apiKey;
        this.fetchImpl = config.fetch ?? fetch;
    }

    public async search(query: string, limit: number): Promise<WebSearchResult[]> {
        const response = await this.fetchImpl('https://api.tavily.com/search', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                api_key: this.apiKey,
                query,
                max_results: limit,
                search_depth: 'basic'
            })
        });

        if (!response.ok) {
            throw new Error(`Tavily ${response.status}: ${await response.text()}`);
        }

        const body = await response.json() as {results?: Array<{url: string; title: string; content?: string}>};

        return (body.results ?? []).slice(0, limit).map((r) => ({
            url: r.url,
            title: r.title,
            ...(r.content !== undefined ? {snippet: r.content} : {})
        }));
    }
}

class SearxngProvider implements WebSearchProvider {
    public readonly kind = 'searxng' as const;
    private readonly url: string;
    private readonly fetchImpl: typeof fetch;

    public constructor(config: SearxngConfig) {
        this.url = config.url.replace(/\/$/, '');
        this.fetchImpl = config.fetch ?? fetch;
    }

    public async search(query: string, limit: number): Promise<WebSearchResult[]> {
        const params = new URLSearchParams({q: query, format: 'json'});
        const response = await this.fetchImpl(`${this.url}/search?${params.toString()}`);

        if (!response.ok) {
            throw new Error(`SearXNG ${response.status}: ${await response.text()}`);
        }

        const body = await response.json() as {results?: Array<{url: string; title: string; content?: string}>};

        return (body.results ?? []).slice(0, limit).map((r) => ({
            url: r.url,
            title: r.title,
            ...(r.content !== undefined ? {snippet: r.content} : {})
        }));
    }
}

export const createWebSearchProvider = (config: WebSearchConfig): WebSearchProvider => {
    switch (config.kind) {
        case 'tavily': return new TavilyProvider(config);
        case 'searxng': return new SearxngProvider(config);
    }
};

const SYSTEM_PROMPT = `Du beantwortest die Frage des Nutzers ausschließlich basierend auf den folgenden Web-Suchergebnissen. Antworte präzise und in der Sprache der Frage. Zitiere für jede Aussage die Quelle als [^N] passend zur nummerierten Liste der Quellen. Wenn die Quellen die Frage nicht beantworten können, sag das ehrlich — erfinde nichts.${INFOGRAPHIC_GUIDE}`;

const stripHtml = (html: string): string => {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
};

const FETCH_LIMIT_BYTES = 200_000;
const SNIPPET_CHARS = 1200;

const fetchPageText = async (url: string, fetchImpl: typeof fetch, abort?: AbortSignal): Promise<string> => {
    const init: RequestInit = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SynaipseResearch/0.1; +https://github.com/swirelo/synaipse)'
        }
    };

    if (abort !== undefined) init.signal = abort;

    const response = await fetchImpl(url, init);
    if (!response.ok) throw new Error(`fetch ${response.status}`);

    const ctype = response.headers.get('content-type') ?? '';
    if (!ctype.includes('html') && !ctype.includes('text')) {
        throw new Error(`non-text content-type: ${ctype}`);
    }

    const buf = await response.arrayBuffer();
    const slice = new Uint8Array(buf, 0, Math.min(buf.byteLength, FETCH_LIMIT_BYTES));
    const html = new TextDecoder().decode(slice);
    return stripHtml(html).slice(0, SNIPPET_CHARS * 5);
};

export interface RunResearchDeps {
    llm: LlmProvider;
    search: WebSearchProvider;
    fetch?: typeof fetch;
}

export interface RunResearchOptions {
    question: string;
    limit?: number;
    abort?: AbortSignal;
}

export async function* runResearch(
    deps: RunResearchDeps,
    options: RunResearchOptions
): AsyncGenerator<ResearchEvent, void, void> {
    const limit = options.limit ?? 5;
    const fetchImpl = deps.fetch ?? fetch;

    yield {kind: 'status', message: `searching the web via ${deps.search.kind}…`};

    let hits: WebSearchResult[] = [];
    try {
        hits = await deps.search.search(options.question, limit);
    } catch (cause) {
        yield {kind: 'error', message: `search failed: ${String(cause)}`};
        return;
    }

    if (hits.length === 0) {
        yield {kind: 'error', message: 'no web results'};
        return;
    }

    yield {kind: 'status', message: `fetching ${hits.length} pages…`};

    const sources: ResearchSource[] = [];
    let i = 0;

    for (const hit of hits) {
        i += 1;
        let snippet = hit.snippet ?? '';

        if (snippet.length < 200) {
            try {
                snippet = await fetchPageText(hit.url, fetchImpl, options.abort);
            } catch (cause) {
                // keep the search-result snippet (possibly empty) and continue.
                yield {kind: 'status', message: `page ${i}: ${String(cause).slice(0, 80)}`};
            }
        }

        sources.push({
            index: i,
            url: hit.url,
            title: hit.title,
            snippet: snippet.slice(0, SNIPPET_CHARS).trim()
        });
    }

    yield {kind: 'sources', sources};

    const context = sources.map((s) => `[^${s.index}] **${s.title}** (${s.url})\n${s.snippet}`).join('\n\n---\n\n');
    const userPrompt = `Web-Suchergebnisse:\n\n${context}\n\n---\n\nFrage: ${options.question}`;

    let totalTokens = 0;

    try {
        for await (const event of deps.llm.stream({
            system: SYSTEM_PROMPT,
            user: userPrompt,
            ...(options.abort !== undefined ? {abort: options.abort} : {})
        })) {
            if (event.token !== undefined) yield {kind: 'token', text: event.token};
            if (event.done === true) totalTokens = event.totalTokens ?? 0;
        }

        yield {kind: 'done', totalTokens, sources};
    } catch (cause) {
        yield {kind: 'error', message: String(cause)};
    }
}