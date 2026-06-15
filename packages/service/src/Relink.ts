import type {LlmProvider} from './Llm.js';

/**
 * Auto-linker: takes a note + a candidate list of other vault notes, asks
 * the LLM which ones are actually related to the source, and returns the
 * accepted titles. Falls back to a deterministic top-N pick when no LLM is
 * available — that keeps the feature usable on rate-limited setups.
 */

export interface RelinkCandidate {
    noteId: string;
    title: string;
    snippet?: string;
    score: number;
}

export type RelinkEvent =
    | {kind: 'token'; text: string}
    | {kind: 'done'; accepted: string[]}
    | {kind: 'error'; message: string};

const RELINK_PROMPT = `Du bekommst eine Quell-Note und eine Liste von möglicherweise verwandten Vault-Notes.

Antworte ausschließlich mit einem JSON-Array, das die Titel der Notes enthält, die TATSÄCHLICH thematisch verwandt zur Quell-Note sind. Inhalt-leere Verwandtschaften (gleicher Crawler, gleiches Datum, gemeinsame Tags ohne inhaltlichen Bezug) NICHT aufnehmen.

Maximum 5 Treffer. Wenn keine Note inhaltlich passt, antworte mit einem leeren Array \`[]\`.

Format: ["Titel 1", "Titel 2"]
Keine Markdown-Codefence, keine Erklärung, keine Einleitung.`;

const buildRelinkPrompt = (
    sourceTitle: string,
    sourceSnippet: string,
    candidates: readonly RelinkCandidate[]
): string => {
    const candidateBlock = candidates
        .map((c, i) => {
            const snippet = c.snippet === undefined ? '' : `\n${c.snippet.slice(0, 240).trim()}`;
            return `${i + 1}. **${c.title}** (score=${c.score.toFixed(2)})${snippet}`;
        })
        .join('\n\n');

    return `Quell-Note: **${sourceTitle}**\n\n${sourceSnippet.slice(0, 1200).trim()}\n\n---\n\nKandidaten:\n\n${candidateBlock}`;
};

const stripJsonFence = (raw: string): string => {
    let s = raw.trim();

    if (s.startsWith('```')) {
        const nl = s.indexOf('\n');
        if (nl !== -1) s = s.slice(nl + 1);
    }

    if (s.endsWith('```')) {
        s = s.slice(0, -3).trim();
    }

    return s.trim();
};

export async function* runRelink(
    provider: LlmProvider,
    sourceTitle: string,
    sourceSnippet: string,
    candidates: readonly RelinkCandidate[],
    abort?: AbortSignal
): AsyncGenerator<RelinkEvent, void, void> {
    if (candidates.length === 0) {
        yield {kind: 'done', accepted: []};
        return;
    }

    const user = buildRelinkPrompt(sourceTitle, sourceSnippet, candidates);
    let raw = '';

    try {
        for await (const event of provider.stream({
            system: RELINK_PROMPT,
            user,
            ...(abort !== undefined ? {abort} : {})
        })) {
            if (event.token !== undefined) {
                raw += event.token;
                yield {kind: 'token', text: event.token};
            }
        }

        const cleaned = stripJsonFence(raw);

        try {
            const parsed = JSON.parse(cleaned) as unknown;

            if (Array.isArray(parsed)) {
                const accepted = parsed.filter((p): p is string => typeof p === 'string');
                yield {kind: 'done', accepted};
                return;
            }

            yield {kind: 'done', accepted: []};
        } catch {
            yield {kind: 'error', message: `LLM response did not parse as JSON: ${cleaned.slice(0, 200)}`};
        }
    } catch (cause) {
        yield {kind: 'error', message: String(cause)};
    }
}

/** Find and remove an existing "## Related" section so re-runs overwrite it cleanly. */
export const stripRelatedSection = (content: string): string => {
    return content.replace(/\n+## Related\n[\s\S]*?(?=\n## |$)/g, '\n');
};

export const renderRelatedSection = (titles: readonly string[]): string => {
    if (titles.length === 0) return '';
    const lines = titles.map((t) => `- [[${t}]]`);
    return `\n## Related\n\n${lines.join('\n')}\n`;
};