import type {SearchHit} from '@synaipse/core';
import type {LlmProvider} from './Llm.js';
import type {RedactionHit} from './Privacy.js';

export interface ChatSource {
    index: number;
    noteId: string;
    title: string;
    score: number;
    snippet?: string;
}

export interface ChatPrivacyStats {
    /** Notes dropped from the source pool because they're marked private (Layer 2). */
    filteredPrivate?: number;
    /** Per-kind counts of secrets scrubbed from the prompt (Layer 3). */
    redactions?: RedactionHit[];
}

export type ChatEvent =
    | ({kind: 'start'; sources: ChatSource[]; model: string} & ChatPrivacyStats)
    | {kind: 'token'; text: string}
    | {kind: 'done'; totalTokens: number}
    | {kind: 'error'; message: string};

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface ChatOptions {
    question: string;
    pathPrefix?: string;
    limit?: number;
    abort?: AbortSignal;
    /** Previous turns (excluding the new question). Adds context for follow-ups. */
    history?: readonly ChatMessage[];
}

/** @deprecated kept as type alias for tests. Real config now flows through LlmConfig. */
export interface ChatProviderConfig {
    url: string;
    model: string;
    fetch?: typeof fetch;
}

const SYSTEM_PROMPT = `Du beantwortest Fragen ausschließlich basierend auf den folgenden Notizen aus dem persönlichen Vault des Nutzers. Antworte präzise und in der Sprache der Frage. Zitiere für jede Aussage die Quelle als [^N] passend zur nummerierten Liste der Notizen. Wenn die Notizen die Frage nicht beantworten, sag das ehrlich — erfinde nichts. Bei Folgefragen berücksichtige den bisherigen Gesprächsverlauf, aber stütze neue Aussagen auf die für DIESE Frage gelieferten Notizen.`;

const SUMMARIZE_PROMPT = `Fasse die folgende Notiz in 2-3 Sätzen zusammen, in der Sprache der Notiz. Antworte ausschließlich mit der reinen Zusammenfassung — keine Einleitung, keine Anführungszeichen, keine Markdown-Formatierung, kein Bullet-List. Behalte konkrete Namen, Zahlen und Entscheidungen bei.`;

export type SummarizeEvent =
    | {kind: 'token'; text: string}
    | {kind: 'done'; summary: string}
    | {kind: 'error'; message: string};

export async function* runSummarize(
    provider: LlmProvider,
    noteContent: string,
    abort?: AbortSignal
): AsyncGenerator<SummarizeEvent, void, void> {
    const trimmed = noteContent.replace(/^---[\s\S]*?---\n?/, '').slice(0, 12_000).trim();

    if (trimmed.length === 0) {
        yield {kind: 'error', message: 'note is empty'};
        return;
    }

    let summary = '';

    try {
        for await (const event of provider.stream({
            system: SUMMARIZE_PROMPT,
            user: trimmed,
            ...(abort !== undefined ? {abort} : {})
        })) {
            if (event.token !== undefined) {
                summary += event.token;
                yield {kind: 'token', text: event.token};
            }
        }

        yield {kind: 'done', summary: summary.trim()};
    } catch (cause) {
        yield {kind: 'error', message: String(cause)};
    }
}

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

export interface RunChatDeps {
    search: (q: string, prefix: string | undefined, limit: number) => Promise<SearchHit[]>;
    readNote: (id: string) => string | undefined;
    provider: LlmProvider;
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
    const limit = options.limit ?? 12;
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

    // Display label: fall back to the provider kind when the model field
    // is empty (e.g. claude-shell without an explicit alias — the CLI uses
    // its own default but we still need *something* identifying for the
    // chat badge and the persisted `<!--chat:assistant model="…"-->` attr).
    const modelLabel = deps.provider.model.length > 0
        ? deps.provider.model
        : deps.provider.kind;

    yield {kind: 'start', sources, model: modelLabel};

    const context = buildContext(sources);
    const userPrompt = buildUserPrompt(options.question, context);

    let totalTokens = 0;

    try {
        for await (const event of deps.provider.stream({
            system: SYSTEM_PROMPT,
            user: userPrompt,
            ...(options.history !== undefined ? {history: options.history} : {}),
            ...(options.abort !== undefined ? {abort: options.abort} : {})
        })) {
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