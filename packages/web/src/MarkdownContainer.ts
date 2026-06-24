import type {marked as MarkedNamespace, Tokens} from 'marked';

/**
 * Block-level marked extension for `::: <type> [{ attrs }]\n…\n:::`
 * container fences. The same fence syntax that `stripContainers` in
 * `packages/service/src/Containers.ts` removes from LLM payloads — here
 * we render it as a card in the web UI.
 *
 * Examples this recognises:
 *
 *   ::: infographic
 *   Body
 *   :::
 *
 *   ::: infographic { icon: "🚀", color: "blue", step: 1 }
 *   Phase Alpha
 *   :::
 *
 *   ::: warning Some optional title
 *   careful here
 *   :::
 *
 * Output shape:
 *
 *   <div class="md-container md-container-<type> md-container-color-<color>">
 *     <div class="md-container-header">
 *       <span class="md-container-step">1</span>
 *       <span class="md-container-icon">🚀</span>
 *       <span class="md-container-title">Optional title</span>
 *     </div>
 *     <div class="md-container-body">…parsed markdown…</div>
 *   </div>
 *
 * Header parts are only emitted when present. The body is parsed as
 * full block-level markdown (recursive marked-lex), so a container can
 * hold lists, headings, code blocks etc.
 *
 * Security notes:
 *  - The `type` is constrained by the tokenizer regex to `[A-Za-z][\w-]*`,
 *    so it's safe to interpolate into a class name without escaping.
 *  - `color` is checked against an allow-list (one of the theme CSS
 *    variable names). Unknown values are dropped — never inlined into a
 *    style attribute. This keeps a malicious author from injecting CSS.
 *  - `icon` and `title` are HTML-escaped before insertion. Emojis pass
 *    through escaping unchanged.
 *  - `step` is coerced to a string and escaped. Non-string/non-numeric
 *    values are dropped.
 */

type AttrValue = string | number | boolean;

interface ContainerToken extends Tokens.Generic {
    type: 'container';
    raw: string;
    containerType: string;
    attrs: Record<string, AttrValue>;
    headerTitle: string;
    tokens: Tokens.Generic[];
}

const FENCE_RE = /^:::[ \t]*([A-Za-z][\w-]*)[ \t]*(\{[^}\n]*\})?[ \t]*([^\n]*)\n([\s\S]*?)\n:::(?:\n|$)/;
const START_RE = /(^|\n):::[ \t]*[A-Za-z]/;

const COLOR_ALLOWLIST: ReadonlySet<string> = new Set([
    'blue', 'green', 'red', 'purple', 'pink', 'gold', 'gray', 'accent'
]);

const escapeHtml = (s: string): string => {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

/**
 * Tiny attribute parser for the `{ key: value, key: value }` payload.
 * Accepts: bare identifiers (key), double-quoted strings (value),
 * single-quoted strings (value), integers, booleans. Anything else is
 * dropped silently. Intentionally not a JSON parser — the syntax is
 * looser (unquoted keys, optional commas) to feel natural in markdown.
 */
const parseAttrs = (raw: string | undefined): Record<string, AttrValue> => {
    if (raw === undefined || raw.length === 0) return {};

    const inner = raw.replace(/^\{/, '').replace(/\}$/, '').trim();
    if (inner.length === 0) return {};

    const out: Record<string, AttrValue> = {};
    // Split on commas at top level (no nested objects supported here).
    const pairs = inner.split(',');

    for (const pair of pairs) {
        const m = /^\s*([A-Za-z][\w-]*)\s*:\s*(.+?)\s*$/.exec(pair);
        if (m === null) continue;

        const key = m[1] as string;
        const rawValue = m[2] as string;

        if (/^"(.*)"$/.test(rawValue)) {
            out[key] = rawValue.slice(1, -1);
        } else if (/^'(.*)'$/.test(rawValue)) {
            out[key] = rawValue.slice(1, -1);
        } else if (/^-?\d+$/.test(rawValue)) {
            out[key] = parseInt(rawValue, 10);
        } else if (rawValue === 'true') {
            out[key] = true;
        } else if (rawValue === 'false') {
            out[key] = false;
        }
        // bare identifiers as values: dropped on purpose (avoid surprises).
    }

    return out;
};

const renderHeaderParts = (token: ContainerToken): string => {
    const parts: string[] = [];

    if (typeof token.attrs.step === 'number' || typeof token.attrs.step === 'string') {
        parts.push(`<span class="md-container-step">${escapeHtml(String(token.attrs.step))}</span>`);
    }

    if (typeof token.attrs.icon === 'string' && token.attrs.icon.length > 0) {
        parts.push(`<span class="md-container-icon">${escapeHtml(token.attrs.icon)}</span>`);
    }

    const title = token.headerTitle.trim();
    if (title.length > 0) {
        parts.push(`<span class="md-container-title">${escapeHtml(title)}</span>`);
    }

    return parts.join('');
};

const classFor = (token: ContainerToken): string => {
    const classes = ['md-container', `md-container-${token.containerType}`];

    if (typeof token.attrs.color === 'string' && COLOR_ALLOWLIST.has(token.attrs.color)) {
        classes.push(`md-container-color-${token.attrs.color}`);
    }

    return classes.join(' ');
};

let installed = false;

export const setupContainerExtension = (marked: typeof MarkedNamespace): void => {
    if (installed) return;
    installed = true;

    marked.use({
        extensions: [{
            name: 'container',
            level: 'block',
            start(src: string): number | undefined {
                const m = START_RE.exec(src);
                if (m === null) return undefined;
                // Adjust index past the leading newline if there was one.
                return m.index + (m[1] === '\n' ? 1 : 0);
            },
            tokenizer(src: string): ContainerToken | undefined {
                const match = FENCE_RE.exec(src);
                if (match === null) return undefined;

                const raw = match[0] as string;
                const containerType = match[1] as string;
                const attrsRaw = match[2];
                const headerTitle = (match[3] ?? '') as string;
                const body = (match[4] ?? '') as string;

                const token: ContainerToken = {
                    type: 'container',
                    raw,
                    containerType,
                    attrs: parseAttrs(attrsRaw),
                    headerTitle,
                    tokens: []
                };

                this.lexer.blockTokens(body, token.tokens);
                return token;
            },
            renderer(rawToken): string {
                const token = rawToken as ContainerToken;
                const inner = this.parser.parse(token.tokens);
                const header = renderHeaderParts(token);
                const headerHtml = header.length > 0
                    ? `<div class="md-container-header">${header}</div>`
                    : '';

                return `<div class="${classFor(token)}">${headerHtml}<div class="md-container-body">${inner}</div></div>\n`;
            }
        }]
    });
};
