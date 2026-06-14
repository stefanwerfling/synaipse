import type {SearchHit} from '@synaipse/core';

export interface ChatSource {
    index: number;
    noteId: string;
    title: string;
    score: number;
    snippet?: string;
}

export type ChatEvent =
    | {kind: 'start'; sources: ChatSource[]; model: string}
    | {kind: 'token'; text: string}
    | {kind: 'done'; totalTokens: number}
    | {kind: 'error'; message: string};

export interface ChatOptions {
    question: string;
    pathPrefix?: string;
    limit?: number;
    abort?: AbortSignal;
}

export interface ChatProviderConfig {
    url: string;
    model: string;
    fetch?: typeof fetch;
}

const SYSTEM_PROMPT = `Du beantwortest Fragen ausschließlich basierend auf den folgenden Notizen aus dem persönlichen Vault des Nutzers. Antworte präzise und in der Sprache der Frage. Zitiere für jede Aussage die Quelle als [^N] passend zur nummerierten Liste der Notizen. Wenn die Notizen die Frage nicht beantworten, sag das ehrlich — erfinde nichts.`;

const buildContext = (sources: ChatSource[]): string => {
    const blocks: string[] = [];

    for (const s of sources) {
        const snippet = s.snippet === undefined ? '' : s.snippet;
        blocks.push(`[^${s.index}] **${s.title}** (\`${s.noteId}\`)\n${snippet}`.trim());
    }

    return blocks.join('\n\n---\n\n');
};

const buildUserPrompt = (question: string, context: string): string => {
    if (context.length === 0) {
        return question;
    }

    return `Notizen aus dem Vault:\n\n${context}\n\n---\n\nFrage: ${question}`;
};

const hitsToSources = (hits: SearchHit[], previews: Map<string, string>): ChatSource[] => {
    return hits.map((hit, i) => {
        const snippet = hit.snippet ?? previews.get(hit.noteId);
        return {
            index: i + 1,
            noteId: hit.noteId,
            title: hit.title,
            score: hit.score,
            ...(snippet !== undefined ? {snippet} : {})
        };
    });
};

interface OllamaStreamLine {
    message?: {role: string; content: string};
    done?: boolean;
    eval_count?: number;
}

const parseStreamLines = (chunk: string): OllamaStreamLine[] => {
    const lines: OllamaStreamLine[] = [];

    for (const raw of chunk.split('\n')) {
        const line = raw.trim();

        if (line.length === 0) {
            continue;
        }

        try {
            lines.push(JSON.parse(line) as OllamaStreamLine);
        } catch {
            // ignore bad JSON fragments — they appear when a chunk splits a line
        }
    }

    return lines;
};

export async function* streamOllamaChat(
    config: ChatProviderConfig,
    system: string,
    user: string,
    abort?: AbortSignal
): AsyncGenerator<{token?: string; totalTokens?: number; done?: boolean}, void, void> {
    const fetchImpl = config.fetch ?? fetch;
    const body = {
        model: config.model,
        messages: [
            {role: 'system', content: system},
            {role: 'user', content: user}
        ],
        stream: true
    };

    const init: RequestInit = {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
    };

    if (abort !== undefined) {
        init.signal = abort;
    }

    const response = await fetchImpl(`${config.url.replace(/\/$/, '')}/api/chat`, init);

    if (!response.ok) {
        throw new Error(`Ollama ${response.status}: ${await response.text()}`);
    }

    if (response.body === null) {
        throw new Error('Ollama returned no body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const {value, done} = await reader.read();

        if (done) {
            break;
        }

        buffer += decoder.decode(value, {stream: true});
        const newlineIdx = buffer.lastIndexOf('\n');

        if (newlineIdx === -1) {
            continue;
        }

        const ready = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        for (const parsed of parseStreamLines(ready)) {
            if (parsed.message?.content !== undefined && parsed.message.content.length > 0) {
                yield {token: parsed.message.content};
            }

            if (parsed.done) {
                yield {done: true, ...(parsed.eval_count !== undefined ? {totalTokens: parsed.eval_count} : {})};
            }
        }
    }

    if (buffer.trim().length > 0) {
        for (const parsed of parseStreamLines(buffer)) {
            if (parsed.message?.content !== undefined && parsed.message.content.length > 0) {
                yield {token: parsed.message.content};
            }

            if (parsed.done) {
                yield {done: true, ...(parsed.eval_count !== undefined ? {totalTokens: parsed.eval_count} : {})};
            }
        }
    }
}

export interface RunChatDeps {
    search: (q: string, prefix: string | undefined, limit: number) => Promise<SearchHit[]>;
    readNote: (id: string) => string | undefined;
    provider: ChatProviderConfig;
}

const SNIPPET_CHARS = 500;

const cleanSnippet = (content: string): string => {
    const noFrontmatter = content.replace(/^---[\s\S]*?---\n?/, '');
    return noFrontmatter.slice(0, SNIPPET_CHARS).trim();
};

export async function* runChat(
    deps: RunChatDeps,
    options: ChatOptions
): AsyncGenerator<ChatEvent, void, void> {
    const limit = options.limit ?? 8;
    const hits = await deps.search(options.question, options.pathPrefix, limit);

    const previews = new Map<string, string>();

    for (const hit of hits) {
        if (hit.snippet === undefined) {
            const content = deps.readNote(hit.noteId);

            if (content !== undefined) {
                previews.set(hit.noteId, cleanSnippet(content));
            }
        }
    }

    const sources = hitsToSources(hits, previews);

    yield {kind: 'start', sources, model: deps.provider.model};

    const context = buildContext(sources);
    const userPrompt = buildUserPrompt(options.question, context);

    let totalTokens = 0;

    try {
        for await (const event of streamOllamaChat(deps.provider, SYSTEM_PROMPT, userPrompt, options.abort)) {
            if (event.token !== undefined) {
                yield {kind: 'token', text: event.token};
            }

            if (event.done) {
                totalTokens = event.totalTokens ?? 0;
            }
        }

        yield {kind: 'done', totalTokens};
    } catch (cause) {
        yield {kind: 'error', message: String(cause)};
    }
}