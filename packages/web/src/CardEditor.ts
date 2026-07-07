import {marked} from 'marked';
import TurndownService from 'turndown';
import {gfm} from 'turndown-plugin-gfm';
import {el} from './Dom.js';

/**
 * WYSIWYG editor for canvas text cards. Roundtrip goal is lossless for
 * everything the toolbar can format (headings, bold/italic, lists,
 * links, inline code, tables, task-lists, blockquotes, HR) plus safe
 * pass-through of opaque blocks the editor can't touch (`:::name` fences
 * from mdfloor/antv-infographic, code fences, wikilinks). Opaque blocks
 * are rendered as read-only placeholder boxes inside the editor and
 * swapped back verbatim on commit — the user sees them, moves around
 * them, but can't corrupt them.
 */

/**
 * Regexes for source constructs the WYSIWYG round-trip can't safely
 * handle. Anything that matches gets replaced with a token placeholder
 * before the markdown reaches marked, then restored after turndown.
 *
 * Order matters: fenced code first (may contain `:::` inside), then
 * `:::` container blocks, then wikilinks. Each regex uses non-greedy
 * body matching so adjacent blocks don't merge.
 */
const OPAQUE_PATTERNS: {label: string; icon: string; re: RegExp}[] = [
    {label: 'code', icon: '⌘', re: /```[^\n]*\n[\s\S]*?\n```/g},
    {label: 'code', icon: '⌘', re: /~~~[^\n]*\n[\s\S]*?\n~~~/g},
    {label: 'block', icon: '📦', re: /^:::[^\n]*\n[\s\S]*?\n:::\s*$/gm},
    {label: 'wikilink', icon: '🔗', re: /\[\[[^\]\n]+\]\]/g}
];

const TOKEN_PREFIX = 'CANVASEDITTOKEN';

interface OpaqueToken {
    id: number;
    source: string;
    label: string;
    icon: string;
    firstLine: string;
}

interface Tokenized {
    sanitized: string;
    tokens: OpaqueToken[];
}

/**
 * Walks the source and swaps every opaque construct for a
 * `⟪CANVASEDITTOKEN0⟫`-style placeholder. Placeholders are picked so
 * marked() renders them as inline text inside a paragraph, which the
 * caller then finds via textContent-scan and replaces with an
 * uneditable box.
 */
const tokenize = (source: string): Tokenized => {
    let sanitized = source;
    const tokens: OpaqueToken[] = [];

    for (const {label, icon, re} of OPAQUE_PATTERNS) {
        sanitized = sanitized.replace(re, (match) => {
            const id = tokens.length;
            const firstLine = match.split('\n', 1)[0] ?? label;
            tokens.push({id, source: match, label, icon, firstLine});
            return `⟪${TOKEN_PREFIX}${id}⟫`;
        });
    }

    return {sanitized, tokens};
};

const shortLabelFor = (token: OpaqueToken): string => {
    const line = token.firstLine.trim();
    if (token.label === 'wikilink') {
        return line.slice(2, -2);
    }
    if (line.startsWith(':::')) {
        return line.slice(3).trim() || 'block';
    }
    if (line.startsWith('```') || line.startsWith('~~~')) {
        const lang = line.slice(3).trim();
        return lang.length > 0 ? `code (${lang})` : 'code';
    }
    return token.label;
};

/**
 * Replaces marked's rendered token-text with contentEditable=false
 * placeholder boxes. Walks a live tree because marked wraps our token
 * strings inside `<p>` (for `:::/```` blocks) or leaves them inline
 * (wikilinks). Both cases are handled by scanning text nodes.
 */
const swapTokensInHtml = (root: HTMLElement, tokens: OpaqueToken[]): void => {
    if (tokens.length === 0) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const hits: Text[] = [];
    let current = walker.nextNode();
    while (current !== null) {
        if (current.textContent !== null && current.textContent.includes(`⟪${TOKEN_PREFIX}`)) {
            hits.push(current as Text);
        }
        current = walker.nextNode();
    }

    const tokenRe = new RegExp(`⟪${TOKEN_PREFIX}(\\d+)⟫`, 'g');

    for (const textNode of hits) {
        const raw = textNode.textContent ?? '';
        const parent = textNode.parentNode;
        if (parent === null) continue;

        const frag = document.createDocumentFragment();
        let lastIdx = 0;
        for (const match of raw.matchAll(tokenRe)) {
            const start = match.index ?? 0;
            const before = raw.slice(lastIdx, start);
            if (before.length > 0) frag.appendChild(document.createTextNode(before));

            const idxStr = match[1];
            const tokenIdx = idxStr === undefined ? -1 : parseInt(idxStr, 10);
            const token = tokens[tokenIdx];
            if (token !== undefined) {
                frag.appendChild(buildTokenBox(token));
            } else {
                frag.appendChild(document.createTextNode(match[0]));
            }
            lastIdx = start + match[0].length;
        }
        const after = raw.slice(lastIdx);
        if (after.length > 0) frag.appendChild(document.createTextNode(after));

        parent.replaceChild(frag, textNode);
    }

    // A `<p>` that now contains only a block-token box is redundant
    // paragraph-chrome — unwrap so the box aligns with siblings.
    for (const box of root.querySelectorAll<HTMLElement>('.canvas-edit-token[data-block="1"]')) {
        const p = box.parentElement;
        if (p !== null && p.tagName === 'P' && p.childNodes.length === 1) {
            p.replaceWith(box);
        }
    }
};

const buildTokenBox = (token: OpaqueToken): HTMLElement => {
    const isBlock = token.label !== 'wikilink';
    const box = el(isBlock ? 'div' : 'span', {
        class: isBlock
            ? 'canvas-edit-token canvas-edit-token-block'
            : 'canvas-edit-token canvas-edit-token-inline',
        attrs: {contenteditable: 'false', title: token.source.slice(0, 240)}
    });
    box.dataset.token = String(token.id);
    if (isBlock) box.dataset.block = '1';
    box.appendChild(document.createTextNode(`${token.icon} ${shortLabelFor(token)}`));
    return box;
};

let cachedTurndown: TurndownService | null = null;

const getTurndown = (): TurndownService => {
    if (cachedTurndown !== null) return cachedTurndown;
    const service = new TurndownService({
        headingStyle: 'atx',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
        emDelimiter: '_',
        strongDelimiter: '**'
    });
    service.use(gfm);

    // Token box → literal placeholder in markdown. The caller then
    // substitutes the original source back in.
    service.addRule('canvas-edit-token', {
        filter: (node) => node.nodeType === 1
            && (node as HTMLElement).classList.contains('canvas-edit-token'),
        replacement: (_content, node) => {
            const el = node as HTMLElement;
            const id = el.dataset.token;
            if (id === undefined) return '';
            const isBlock = el.dataset.block === '1';
            return isBlock
                ? `\n\n⟪${TOKEN_PREFIX}${id}⟫\n\n`
                : `⟪${TOKEN_PREFIX}${id}⟫`;
        }
    });

    cachedTurndown = service;
    return service;
};

/**
 * HTML → Markdown via turndown, then restore opaque tokens verbatim.
 */
const htmlToMarkdown = (html: string, tokens: OpaqueToken[]): string => {
    let md = getTurndown().turndown(html);

    if (tokens.length > 0) {
        const restoreRe = new RegExp(`⟪${TOKEN_PREFIX}(\\d+)⟫`, 'g');
        md = md.replace(restoreRe, (_match, idxStr: string) => {
            const idx = parseInt(idxStr, 10);
            const token = tokens[idx];
            return token !== undefined ? token.source : _match;
        });
    }

    // Turndown normalises trailing newlines to two; canvas source keeps
    // whatever the author had. Trim only pure trailing whitespace so we
    // don't drift edge-of-doc formatting between roundtrips.
    return md.replace(/[ \t]+$/gm, '').trimEnd();
};

export interface CardEditorHandle {
    /** Read current markdown (with opaque blocks restored). */
    getMarkdown: () => string;
    /** Focus the editor surface. */
    focus: () => void;
    /** Detach listeners and clear the host. */
    destroy: () => void;
}

export interface CardEditorOptions {
    /** Fires whenever the user commits (blur, Escape, external stop). */
    onCommit: (markdown: string) => void;
    /** Optional initial focus after mount. */
    autofocus?: boolean;
}

/**
 * Mounts the WYSIWYG editor into `host`, returns a handle. The host is
 * cleared first. The commit callback receives fully round-tripped
 * markdown (opaque blocks preserved). It fires exactly once, on
 * blur/Escape/destroy — not per keystroke.
 */
export const mountCardEditor = (
    host: HTMLElement,
    initialMd: string,
    opts: CardEditorOptions
): CardEditorHandle => {
    host.innerHTML = '';

    const {sanitized, tokens} = tokenize(initialMd);
    const html = marked.parse(sanitized, {async: false, gfm: true}) as string;

    const toolbar = buildToolbar();
    const surface = el('div', {
        class: 'canvas-card-editor md-preview',
        attrs: {contenteditable: 'true', spellcheck: 'false'}
    });
    surface.innerHTML = html;
    swapTokensInHtml(surface, tokens);

    // Empty doc → give the caret a paragraph to live in so the first
    // keystroke doesn't insert a bare text node under the div root.
    if (surface.childNodes.length === 0) {
        surface.appendChild(document.createElement('p'));
    }

    host.appendChild(toolbar);
    host.appendChild(surface);

    let committed = false;
    const doCommit = (): void => {
        if (committed) return;
        committed = true;
        opts.onCommit(htmlToMarkdown(surface.innerHTML, tokens));
    };

    // Toolbar buttons fire commands against the current selection.
    // We keep formatting flow simple: rely on document.execCommand for
    // the classic set (bold/italic/lists/link) rather than reimplementing
    // range surgery. execCommand is deprecated in name only — every
    // browser still ships it and no successor covers this surface.
    toolbar.addEventListener('mousedown', (ev) => {
        // Prevent the toolbar itself from stealing focus mid-format —
        // otherwise the caret jumps out of the editor and execCommand
        // no-ops.
        ev.preventDefault();
    });
    toolbar.addEventListener('click', (ev) => {
        const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-cmd]');
        if (btn === null) return;
        ev.preventDefault();
        ev.stopPropagation();
        surface.focus();
        runCommand(btn.dataset.cmd ?? '', surface);
    });

    // Paste as plain text — arbitrary HTML from external sources would
    // otherwise leak styles + broken markup into the roundtrip.
    surface.addEventListener('paste', (ev) => {
        ev.preventDefault();
        const text = ev.clipboardData?.getData('text/plain') ?? '';
        if (text.length === 0) return;
        document.execCommand('insertText', false, text);
    });

    surface.addEventListener('keydown', (ev) => {
        // Editor-scoped shortcuts. Cmd/Ctrl-B/I/K + Esc to commit.
        if (ev.key === 'Escape') {
            ev.preventDefault();
            doCommit();
            return;
        }
        if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey) {
            const k = ev.key.toLowerCase();
            if (k === 'b') {
                ev.preventDefault();
                runCommand('bold', surface);
            } else if (k === 'i') {
                ev.preventDefault();
                runCommand('italic', surface);
            } else if (k === 'k') {
                ev.preventDefault();
                runCommand('link', surface);
            }
        }
    });

    surface.addEventListener('blur', () => {
        // Delay: clicking a toolbar button fires blur before its click —
        // if we commit synchronously the button no-ops. Skip commit if
        // focus moved into our own toolbar.
        window.setTimeout(() => {
            if (host.contains(document.activeElement)) return;
            doCommit();
        }, 0);
    });

    if (opts.autofocus !== false) {
        surface.focus();
        placeCaretAtEnd(surface);
    }

    return {
        getMarkdown: () => htmlToMarkdown(surface.innerHTML, tokens),
        focus: () => surface.focus(),
        destroy: () => {
            doCommit();
            host.innerHTML = '';
        }
    };
};

const buildToolbar = (): HTMLElement => {
    const bar = el('div', {class: 'canvas-card-editor-toolbar'});
    const buttons: {cmd: string; label: string; title: string}[] = [
        {cmd: 'bold', label: 'B', title: 'Bold (Ctrl+B)'},
        {cmd: 'italic', label: 'I', title: 'Italic (Ctrl+I)'},
        {cmd: 'h1', label: 'H1', title: 'Heading 1'},
        {cmd: 'h2', label: 'H2', title: 'Heading 2'},
        {cmd: 'h3', label: 'H3', title: 'Heading 3'},
        {cmd: 'p', label: '¶', title: 'Paragraph'},
        {cmd: 'ul', label: '•', title: 'Bulleted list'},
        {cmd: 'ol', label: '1.', title: 'Numbered list'},
        {cmd: 'quote', label: '❝', title: 'Blockquote'},
        {cmd: 'code', label: '</>', title: 'Inline code'},
        {cmd: 'link', label: '🔗', title: 'Link (Ctrl+K)'}
    ];
    for (const b of buttons) {
        const btn = el('button', {
            class: 'canvas-card-editor-btn',
            attrs: {type: 'button', title: b.title, 'aria-label': b.title},
            text: b.label
        });
        btn.dataset.cmd = b.cmd;
        bar.appendChild(btn);
    }
    return bar;
};

const runCommand = (cmd: string, surface: HTMLElement): void => {
    switch (cmd) {
        case 'bold':
            document.execCommand('bold');
            return;
        case 'italic':
            document.execCommand('italic');
            return;
        case 'ul':
            document.execCommand('insertUnorderedList');
            return;
        case 'ol':
            document.execCommand('insertOrderedList');
            return;
        case 'quote':
            document.execCommand('formatBlock', false, 'blockquote');
            return;
        case 'h1':
            document.execCommand('formatBlock', false, 'h1');
            return;
        case 'h2':
            document.execCommand('formatBlock', false, 'h2');
            return;
        case 'h3':
            document.execCommand('formatBlock', false, 'h3');
            return;
        case 'p':
            document.execCommand('formatBlock', false, 'p');
            return;
        case 'code':
            wrapSelection(surface, 'code');
            return;
        case 'link': {
            const url = window.prompt('URL', 'https://');
            if (url === null || url.length === 0) return;
            document.execCommand('createLink', false, url);
            return;
        }
    }
};

/**
 * Wraps the current selection (if any) inside `<tag>` — used for inline
 * code where execCommand has no first-class command. If the selection
 * is empty we insert an empty tag and place the caret inside so the
 * next keystroke lands in the right spot.
 */
const wrapSelection = (surface: HTMLElement, tag: string): void => {
    const sel = window.getSelection();
    if (sel === null || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer)) return;

    const wrap = document.createElement(tag);
    if (range.collapsed) {
        wrap.appendChild(document.createTextNode('​'));
        range.insertNode(wrap);
        const newRange = document.createRange();
        newRange.setStart(wrap.firstChild ?? wrap, 1);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
    } else {
        wrap.appendChild(range.extractContents());
        range.insertNode(wrap);
        sel.removeAllRanges();
        const after = document.createRange();
        after.setStartAfter(wrap);
        after.collapse(true);
        sel.addRange(after);
    }
};

const placeCaretAtEnd = (node: Node): void => {
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const sel = window.getSelection();
    if (sel === null) return;
    sel.removeAllRanges();
    sel.addRange(range);
};