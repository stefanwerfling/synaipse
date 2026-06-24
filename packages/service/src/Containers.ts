/**
 * Markdown container blocks — `::: <type> [attrs]\n…\n:::` — are a visual
 * sugar for the web UI (rendered as cards by the marked-Extension in
 * `packages/web/src/MarkdownPreview.ts`). For LLMs the wrapper lines are
 * noise: they bloat token counts, confuse the model about structure, and
 * leak frontmatter-style attribute syntax that the LLM might echo back.
 *
 * `stripContainers` removes opening + closing fence lines but keeps the
 * body verbatim. Pure function — no I/O, no Service dependency. Symmetric
 * to `redactSensitive` in `Privacy.ts`: same shape (`(content) => string`),
 * same place in the pipeline (`Service.prepareForChat` chains both).
 *
 * Strip runs for **all** providers (local + external) because the noise
 * argument is provider-agnostic. PII redaction in contrast only runs for
 * external providers because for local providers nothing leaves the host.
 *
 * Recognised opening shapes (one line, type required, attrs optional):
 *
 *   `::: infographic`
 *   `::: infographic { icon: "🚀", color: "blue", step: 1 }`
 *   `:::warning`              (no space after colons)
 *   `::: tip Some title here` (attrs may be free-form text)
 *
 * Closing fence is exactly `:::` on its own line (optional trailing
 * whitespace). Nesting is not supported — the use case (roadmap stages,
 * tips, warnings) doesn't need it and the simpler tokenizer means fewer
 * edge cases. If a nested case appears, switch to a balanced-counter
 * scanner.
 *
 * Edge cases:
 *  - Lines like `something ::: not a container` are preserved (the fence
 *    must start the line).
 *  - 4+ colons (`:::: …`) are preserved — only exactly three at line start
 *    qualify as a fence.
 *  - Stripping is idempotent: feeding the result back through strips
 *    nothing more (no fences left).
 *  - Unclosed containers strip the opening but leave the body intact —
 *    we don't try to "fix" malformed Markdown, just remove the wrappers
 *    that exist.
 */

const OPEN_FENCE = /^:::\s*[A-Za-z][\w-]*(?:\s.*)?$/;
const CLOSE_FENCE = /^:::\s*$/;

export const stripContainers = (content: string): string => {
    if (!content.includes(':::')) return content;

    const lines = content.split('\n');
    const out: string[] = [];

    for (const line of lines) {
        if (OPEN_FENCE.test(line)) continue;
        if (CLOSE_FENCE.test(line)) continue;
        out.push(line);
    }

    return out.join('\n');
};