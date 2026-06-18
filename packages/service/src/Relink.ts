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

export interface AcceptedLink {
    title: string;
    /** One-sentence rationale (from the LLM) or a snippet excerpt (deterministic mode). */
    reason: string;
    /** Hybrid-search score that surfaced this candidate. */
    score: number;
}

export type RelinkEvent =
    | {kind: 'token'; text: string}
    | {kind: 'done'; accepted: AcceptedLink[]}
    | {kind: 'error'; message: string};

const RELINK_PROMPT = `Du bekommst eine Quell-Note und eine Liste von möglicherweise verwandten Vault-Notes.

Antworte ausschließlich mit einem JSON-Array von Objekten — jedes Objekt enthält den Titel der akzeptierten Note plus einen einzigen, präzisen Satz Begründung warum die Note inhaltlich verwandt ist. Inhalt-leere Verwandtschaften (gleicher Crawler, gleiches Datum, gemeinsame Tags ohne inhaltlichen Bezug) NICHT aufnehmen.

Maximum 5 Treffer. Wenn keine Note inhaltlich passt, antworte mit einem leeren Array \`[]\`.

Format: [{"title": "Titel 1", "reason": "Begründung 1"}, ...]
Keine Markdown-Codefence, keine Einleitung, kein Kommentar.`;

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

    const candidatesByTitle = new Map(candidates.map((c) => [c.title, c]));

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
                const accepted: AcceptedLink[] = [];

                for (const entry of parsed) {
                    // New shape: {title, reason}. Old shape: bare string (legacy).
                    if (typeof entry === 'string') {
                        const c = candidatesByTitle.get(entry);
                        if (c === undefined) continue;
                        accepted.push({
                            title: c.title,
                            reason: c.snippet?.slice(0, 140).trim() ?? '',
                            score: c.score
                        });
                        continue;
                    }

                    if (typeof entry !== 'object' || entry === null) continue;

                    const obj = entry as Record<string, unknown>;
                    const title = typeof obj.title === 'string' ? obj.title : undefined;
                    if (title === undefined) continue;

                    const c = candidatesByTitle.get(title);
                    if (c === undefined) continue;

                    const reason = typeof obj.reason === 'string' && obj.reason.length > 0
                        ? obj.reason.trim()
                        : (c.snippet?.slice(0, 140).trim() ?? '');

                    accepted.push({title: c.title, reason, score: c.score});
                }

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

/**
 * The reason text often comes from another note's body and can contain
 * markdown that breaks the surrounding document — triple-backtick code
 * fences eat everything until the next fence, `[[…]]` mints unwanted
 * wikilinks, leading `#` is parsed as a heading. Flatten to a single safe
 * line before embedding it back into our list.
 */
export const sanitizeReason = (raw: string): string => {
    return raw
        .replace(/\s+/g, ' ')
        .replace(/```/g, "'''")
        .replace(/`/g, "'")
        .replace(/\[\[/g, '⟦')
        .replace(/\]\]/g, '⟧')
        .replace(/^\s*[#>\-*+]\s*/, '')
        .replace(/\|/g, '∣')
        .trim()
        .slice(0, 140);
};

export const renderRelatedSection = (links: readonly AcceptedLink[]): string => {
    if (links.length === 0) return '';

    const lines = links.map((link) => {
        const reason = link.reason.length > 0 ? ` — ${sanitizeReason(link.reason)}` : '';
        return `- [[${link.title}]] *(score ${link.score.toFixed(2)})*${reason}`;
    });

    return `\n## Related\n\n${lines.join('\n')}\n`;
};