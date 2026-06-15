import type {LlmProvider} from './Llm.js';

/**
 * Compile a raw source (crawled article, clipped page) into a structured
 * wiki-style summary via the configured LLM. The output is parsed JSON with
 * a fixed schema, which the caller then renders to markdown.
 */

export interface CompileResult {
    summary: string;
    keyConcepts: Array<{title: string; description: string}>;
    entities: string[];
    /** Raw JSON string the LLM produced — kept for debugging / fallback. */
    rawJson: string;
}

export type CompileEvent =
    | {kind: 'token'; text: string}
    | {kind: 'done'; result: CompileResult | null}
    | {kind: 'error'; message: string};

const COMPILE_PROMPT = `Du bist ein Wissensingenieur, der einen rohen Quelltext in strukturierte Wiki-Bausteine zerlegt.

Antworte ausschließlich mit gültigem JSON in diesem Schema (keine Markdown-Codefences, keine Einleitung, kein Kommentar):

{
  "summary": "Zwei bis drei Sätze in der Sprache der Quelle. Was ist das, wozu dient es, was macht es besonders?",
  "keyConcepts": [
    {"title": "Konzeptname", "description": "Ein bis zwei Sätze, warum dieses Konzept zentral ist."}
  ],
  "entities": ["Eigennamen, Projektnamen, Personen, Organisationen, Versionen — Maximum 12"]
}

Behalte konkrete Namen, Versionen und Zahlen bei. Konzeptlisten sind 3-8 Einträge lang. Erfinde nichts, das nicht in der Quelle steht.`;

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

const validate = (parsed: unknown): parsed is CompileResult => {
    if (typeof parsed !== 'object' || parsed === null) return false;
    const p = parsed as Record<string, unknown>;
    if (typeof p.summary !== 'string') return false;
    if (!Array.isArray(p.keyConcepts)) return false;
    if (!Array.isArray(p.entities)) return false;
    return true;
};

export async function* runCompile(
    provider: LlmProvider,
    sourceContent: string,
    abort?: AbortSignal
): AsyncGenerator<CompileEvent, void, void> {
    const trimmed = sourceContent.replace(/^---[\s\S]*?---\n?/, '').slice(0, 16_000).trim();

    if (trimmed.length === 0) {
        yield {kind: 'error', message: 'source is empty'};
        return;
    }

    let raw = '';

    try {
        for await (const event of provider.stream({
            system: COMPILE_PROMPT,
            user: trimmed,
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

            if (validate(parsed)) {
                yield {kind: 'done', result: {...parsed, rawJson: cleaned}};
                return;
            }

            yield {kind: 'done', result: null};
        } catch {
            yield {kind: 'done', result: null};
        }
    } catch (cause) {
        yield {kind: 'error', message: String(cause)};
    }
}

export const renderCompiledMarkdown = (
    sourceId: string,
    sourceTitle: string,
    result: CompileResult
): string => {
    const lines: string[] = [];
    lines.push(`# ${sourceTitle} — compiled`, '');
    lines.push(`> Compiled summary of [[${sourceTitle}]] (\`${sourceId}\`)`, '');
    lines.push('## Summary', '', result.summary.trim(), '');

    if (result.keyConcepts.length > 0) {
        lines.push('## Key Concepts', '');
        for (const c of result.keyConcepts) {
            lines.push(`- **${c.title}** — ${c.description}`);
        }
        lines.push('');
    }

    if (result.entities.length > 0) {
        lines.push('## Entities', '');
        for (const e of result.entities) {
            lines.push(`- [[${e}]]`);
        }
        lines.push('');
    }

    return lines.join('\n');
};