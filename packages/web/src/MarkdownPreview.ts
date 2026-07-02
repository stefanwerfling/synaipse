import {marked} from 'marked';
import {markedHighlight} from 'marked-highlight';
import hljs from 'highlight.js/lib/common';
import type {TypedLink, TypedLinkKind} from '@synaipse/core';
import {resolveAssetUrl} from './AssetUrl.js';
import {clear, el} from './Dom.js';
import {positionHoverCard} from './HoverCard.js';
import {setupContainerExtension} from './MarkdownContainer.js';
import {splitWikilinkTarget} from './Wikilinks.js';

const KIND_GLYPH: Readonly<Record<TypedLinkKind, string>> = {
    supersedes: '→',
    duplicates: '≡',
    relates_to: '↔',
    replies_to: '↩'
};

const sameTypedLinks = (a: readonly TypedLink[], b: readonly TypedLink[]): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i]?.target !== b[i]?.target) return false;
        if (a[i]?.kind !== b[i]?.kind) return false;
    }
    return true;
};

let highlightConfigured = false;

const configureHighlight = (): void => {
    if (highlightConfigured) {
        return;
    }

    marked.use(markedHighlight({
        langPrefix: 'hljs language-',
        highlight: (code, lang) => {
            const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
            return hljs.highlight(code, {language, ignoreIllegals: true}).value;
        }
    }));

    setupContainerExtension(marked);

    highlightConfigured = true;
};

configureHighlight();

export interface NoteSnippet {
    title: string;
    tags: string[];
    preview: string;
}

export interface MarkdownPreviewOptions {
    resolveWikilink?: (title: string) => string | undefined;
    onWikilinkClick?: (noteId: string, title: string) => void;
    onUnresolvedClick?: (title: string) => void;
    fetchSnippet?: (noteId: string) => Promise<NoteSnippet>;
}

/**
 * Rewrite every `<img>` inside `host` whose src points at a vault asset
 * into a `/api/asset?path=...` URL. Pure DOM walk over the rendered
 * output — done after marked.parse so the rewriting works regardless of
 * which renderer extensions are active. Sources we don't recognize as
 * vault assets (absolute URLs, data:, fragments, unknown extensions)
 * are left untouched.
 */
export const rewriteAssetImages = (host: HTMLElement, noteId: string | undefined): void => {
    const imgs = host.querySelectorAll<HTMLImageElement>('img');
    for (const img of imgs) {
        // `getAttribute` returns the literal markdown src; `img.src` would
        // already resolve against the page URL and lose the relative form
        // we need for noteId-based rewriting.
        const raw = img.getAttribute('src');
        if (raw === null) continue;
        const rewritten = resolveAssetUrl(raw, noteId);
        if (rewritten !== null) {
            img.setAttribute('src', rewritten);
        }
    }
};

const HOVER_OPEN_DELAY = 280;
const HOVER_CLOSE_DELAY = 140;
const CARD_WIDTH = 340;
const CARD_MAX_HEIGHT = 220;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

interface HoverHandle {
    anchor: HTMLElement;
    noteId: string;
}

const renderMarkdown = (content: string): string => {
    return marked.parse(content, {async: false, gfm: true}) as string;
};

/**
 * One-shot render of a markdown string into a host element, with the
 * same code highlighting as the note viewer. Useful for short markdown
 * snippets (chat messages, hover previews) where a full MarkdownPreview
 * instance is overkill. Wikilinks are NOT transformed — caller can run
 * a separate pass if needed.
 *
 * After the sync HTML render we still run the antv-infographic post-
 * pass so that LLM-generated `:::infographic <layout>` blocks in chat
 * replies don't end up as empty stubs. The renderer lazy-loads
 * `@antv/infographic` on first use, so chat turns without infographics
 * pay zero cost.
 */
export const renderMarkdownInto = (host: HTMLElement, content: string, noteId?: string): void => {
    host.innerHTML = renderMarkdown(content);
    rewriteAssetImages(host, noteId);
    void applyAntvInfographicsTo(host);
};

/**
 * Count top-level items in an `::: infographic` body. Every item starts
 * with `- id ` (dagre/relation flows) or `- label ` (charts, timelines) —
 * both under an `items` key. Robust enough for a height heuristic; not a
 * full parser.
 */
const countInfographicItems = (syntax: string): number => {
    let n = 0;
    for (const line of syntax.split('\n')) {
        if (/^\s+-\s+(id|label)\s+/.test(line)) n += 1;
    }
    return n;
};

/**
 * Inline-height heuristic: each item earns ~34 px, clamped to a readable
 * band. A 9-item flow lands at ~666 px (up from the old fixed 540); a
 * 16-item flow at ~904 px. Fullscreen modal handles the extremes.
 */
const heightForInfographic = (syntax: string): number => {
    const items = countInfographicItems(syntax);
    if (items === 0) return 480;
    return Math.min(1100, Math.max(420, 360 + items * 34));
};

let cachedInfographicCtor: typeof import('@antv/infographic').Infographic | null = null;

const loadInfographic = async (): Promise<typeof import('@antv/infographic').Infographic> => {
    if (cachedInfographicCtor !== null) return cachedInfographicCtor;
    const mod = await import('@antv/infographic');
    cachedInfographicCtor = mod.Infographic;
    return cachedInfographicCtor;
};

/**
 * Open a full-viewport modal that re-renders the same infographic syntax
 * at a much larger size. Backdrop click / Escape / close button dismiss
 * it. Kept self-contained (no framework, no global state) — every open
 * builds a fresh subtree and detaches it on close.
 */
const openInfographicFullscreen = async (syntax: string): Promise<void> => {
    let Ctor: typeof import('@antv/infographic').Infographic;
    try {
        Ctor = await loadInfographic();
    } catch {
        return;
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'infographic-modal-backdrop';

    const box = document.createElement('div');
    box.className = 'infographic-modal';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'infographic-modal-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';

    const stage = document.createElement('div');
    stage.className = 'infographic-modal-stage';

    box.appendChild(close);
    box.appendChild(stage);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    const dismiss = (): void => {
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
    };
    const onKey = (ev: KeyboardEvent): void => {
        if (ev.key === 'Escape') dismiss();
    };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (ev) => {
        if (ev.target === backdrop) dismiss();
    });
    close.addEventListener('click', dismiss);

    // Render into the stage using its measured size. Padding accounts for
    // modal chrome (close button, box padding). Fall back to reasonable
    // defaults if layout hasn't settled yet.
    const width = stage.clientWidth > 0 ? stage.clientWidth : Math.floor(window.innerWidth * 0.9);
    const height = stage.clientHeight > 0 ? stage.clientHeight : Math.floor(window.innerHeight * 0.85);

    try {
        const infographic = new Ctor({container: stage, width, height, padding: 32});
        infographic.render(syntax);
    } catch (e) {
        stage.textContent = `Infographic render error: ${e instanceof Error ? e.message : String(e)}`;
        stage.classList.add('md-antv-infographic-error');
    }
};

/**
 * Post-render pass for antv-infographic stubs. Exported so the chat /
 * hover / standalone-render call sites can reuse the same SVG hydration
 * pipeline as the editor preview. Stubs are marked `dataset.rendered`
 * after the first render to make this idempotent for re-renders.
 *
 * Height scales with item count so long flows stay legible in-place, and
 * each rendered stub becomes click-to-fullscreen for the extreme cases.
 */
export const applyAntvInfographicsTo = async (host: HTMLElement): Promise<void> => {
    const stubs = host.querySelectorAll<HTMLDivElement>('.md-antv-infographic');
    if (stubs.length === 0) return;

    let Infographic: typeof import('@antv/infographic').Infographic;
    try {
        Infographic = await loadInfographic();
    } catch (e) {
        for (const stub of stubs) {
            stub.textContent = `Infographic library failed to load: ${e instanceof Error ? e.message : String(e)}`;
            stub.classList.add('md-antv-infographic-error');
        }
        return;
    }

    for (const stub of stubs) {
        if (stub.dataset.rendered === 'true') continue;
        const syntaxJson = stub.dataset.infographicSyntax;
        if (syntaxJson === undefined) continue;

        try {
            const syntax = JSON.parse(syntaxJson) as string;
            const width = stub.clientWidth > 0 ? stub.clientWidth : 900;
            const height = heightForInfographic(syntax);
            const infographic = new Infographic({
                container: stub,
                width,
                height,
                padding: 24
            });
            infographic.render(syntax);
            stub.dataset.rendered = 'true';
            stub.classList.add('md-antv-infographic-clickable');
            stub.title = 'Click to view full-screen';
            stub.addEventListener('click', () => {
                void openInfographicFullscreen(syntax);
            });
        } catch (e) {
            stub.textContent = `Infographic render error: ${e instanceof Error ? e.message : String(e)}`;
            stub.classList.add('md-antv-infographic-error');
        }
    }
};

const isInsideCode = (node: Node): boolean => {
    let parent: Node | null = node.parentNode;

    while (parent && parent.nodeType === Node.ELEMENT_NODE) {
        const tag = (parent as Element).tagName;

        if (tag === 'CODE' || tag === 'PRE') {
            return true;
        }

        parent = parent.parentNode;
    }

    return false;
};

export class MarkdownPreview {
    public readonly element: HTMLElement;
    private content = '';
    private noteId: string | undefined;
    private typedLinks: readonly TypedLink[] = [];
    private hoverCard: HTMLElement | null = null;
    private hoverHandle: HoverHandle | null = null;
    private openTimer: number | null = null;
    private closeTimer: number | null = null;

    public constructor(private readonly opts: MarkdownPreviewOptions = {}) {
        this.element = el('div', {class: 'md-preview'});
    }

    /**
     * Set the vault-relative note id used to resolve relative asset
     * paths (`![](./_assets/img.png)`) into `/api/asset?path=...` URLs.
     * Pass undefined for previews where there is no anchoring note —
     * relative image srcs will then pass through as-is.
     */
    public setNoteId(noteId: string | undefined): void {
        if (this.noteId === noteId) {
            return;
        }
        this.noteId = noteId;
        if (this.content.length > 0) {
            this.render();
        }
    }

    public update(content: string): void {
        if (content === this.content) {
            return;
        }

        this.content = content;
        this.render();
    }

    /**
     * Render typed-link badges from a note's frontmatter (`links: [{target,
     * kind}]`) in a sticky header inside the preview. Empty array hides
     * the header entirely. Resolves targets via opts.resolveWikilink the
     * same way body wikilinks do — clickable when the target resolves,
     * grey "unresolved" style otherwise.
     */
    public setTypedLinks(links: readonly TypedLink[]): void {
        if (sameTypedLinks(this.typedLinks, links)) {
            return;
        }
        this.typedLinks = links;
        this.render();
    }

    public destroy(): void {
        this.clearTimers();
        this.hideCard();
    }

    private render(): void {
        clear(this.element);

        if (this.typedLinks.length > 0) {
            this.element.appendChild(this.renderTypedLinks());
        }

        const body = document.createElement('div');
        body.className = 'md-preview-body';
        body.innerHTML = renderMarkdown(this.content);
        this.element.appendChild(body);

        this.transformWikilinks();
        rewriteAssetImages(body, this.noteId);
        void applyAntvInfographicsTo(this.element);
    }

    private renderTypedLinks(): HTMLElement {
        const host = el('div', {
            class: 'md-preview-typed-links',
            attrs: {'aria-label': 'Frontmatter cross-references'}
        });

        for (const link of this.typedLinks) {
            host.appendChild(this.renderTypedLinkBadge(link));
        }

        return host;
    }

    private renderTypedLinkBadge(link: TypedLink): HTMLElement {
        const noteId = this.opts.resolveWikilink?.(link.target);
        const glyph = KIND_GLYPH[link.kind];
        const klass = `typed-link-badge typed-link-${link.kind}${noteId === undefined ? ' typed-link-unresolved' : ''}`;
        const title = noteId !== undefined
            ? `${link.kind} → ${noteId}`
            : `${link.kind} → ${link.target} (unresolved)`;

        if (noteId !== undefined && this.opts.onWikilinkClick !== undefined) {
            const onClick = this.opts.onWikilinkClick;
            return el('button', {
                class: klass,
                attrs: {type: 'button', title},
                on: {click: () => onClick(noteId, link.target)}
            },
                el('span', {class: 'typed-link-glyph', text: glyph}),
                el('span', {class: 'typed-link-kind', text: link.kind.replace(/_/g, ' ')}),
                el('span', {class: 'typed-link-target', text: link.target})
            );
        }

        return el('span', {class: klass, attrs: {title}},
            el('span', {class: 'typed-link-glyph', text: glyph}),
            el('span', {class: 'typed-link-kind', text: link.kind.replace(/_/g, ' ')}),
            el('span', {class: 'typed-link-target', text: link.target})
        );
    }

    private transformWikilinks(): void {
        const walker = document.createTreeWalker(this.element, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                if (isInsideCode(node)) {
                    return NodeFilter.FILTER_REJECT;
                }

                return WIKILINK_RE.test(node.nodeValue ?? '')
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT;
            }
        });

        const targets: Text[] = [];
        let current = walker.nextNode();

        while (current !== null) {
            targets.push(current as Text);
            current = walker.nextNode();
        }

        for (const textNode of targets) {
            this.replaceWikilinksInTextNode(textNode);
        }
    }

    private replaceWikilinksInTextNode(textNode: Text): void {
        const text = textNode.nodeValue ?? '';
        const frag = document.createDocumentFragment();
        let last = 0;

        for (const match of text.matchAll(WIKILINK_RE)) {
            const start = match.index ?? 0;

            if (start > last) {
                frag.appendChild(document.createTextNode(text.slice(last, start)));
            }

            const {title, label} = splitWikilinkTarget(match[1] ?? '');
            const noteId = this.opts.resolveWikilink?.(title);

            frag.appendChild(this.wikilinkElement(noteId, title, label));
            last = start + match[0].length;
        }

        if (last < text.length) {
            frag.appendChild(document.createTextNode(text.slice(last)));
        }

        textNode.replaceWith(frag);
    }

    private wikilinkElement(noteId: string | undefined, title: string, label: string): HTMLElement {
        if (title.startsWith('dsgvo:')) {
            const kind = title.slice('dsgvo:'.length);
            return el('span', {
                class: 'dsgvo-pill',
                attrs: {title: `DSGVO-Marker (${kind}) — wird bei externem LLM zu [redact:${kind}]`}
            },
                el('span', {class: 'dsgvo-pill-icon', text: '🔒'}),
                el('span', {class: 'dsgvo-pill-kind', text: kind}),
                el('span', {class: 'dsgvo-pill-text', text: label})
            );
        }

        if (noteId !== undefined && this.opts.onWikilinkClick !== undefined) {
            const onClick = this.opts.onWikilinkClick;
            const button = el('button', {
                class: 'wikilink wikilink-clickable',
                attrs: {type: 'button', title: noteId},
                text: label,
                on: {click: () => onClick(noteId, title)}
            });

            if (this.opts.fetchSnippet !== undefined) {
                button.addEventListener('mouseenter', () => this.startOpen(button, noteId));
                button.addEventListener('mouseleave', () => this.scheduleClose());
            }

            return button;
        }

        if (noteId === undefined && this.opts.onUnresolvedClick !== undefined) {
            const onUnresolved = this.opts.onUnresolvedClick;
            return el('button', {
                class: 'wikilink unresolved unresolved-clickable',
                attrs: {type: 'button', title: `Create note "${title}"`},
                text: label,
                on: {click: () => onUnresolved(title)}
            });
        }

        return el('span', {
            class: noteId === undefined ? 'wikilink unresolved' : 'wikilink',
            attrs: {title: noteId === undefined ? 'unresolved wikilink' : noteId},
            text: label
        });
    }

    private clearTimers(): void {
        if (this.openTimer !== null) {
            window.clearTimeout(this.openTimer);
            this.openTimer = null;
        }
        if (this.closeTimer !== null) {
            window.clearTimeout(this.closeTimer);
            this.closeTimer = null;
        }
    }

    private startOpen(anchor: HTMLElement, noteId: string): void {
        const fetchSnippet = this.opts.fetchSnippet;

        if (fetchSnippet === undefined) {
            return;
        }

        this.clearTimers();

        this.openTimer = window.setTimeout(() => {
            this.openTimer = null;
            this.hoverHandle = {anchor, noteId};
            this.showCard(anchor, null, true);

            fetchSnippet(noteId)
                .then((snippet) => {
                    if (this.hoverHandle?.noteId === noteId) {
                        this.showCard(anchor, snippet, false);
                    }
                })
                .catch(() => {
                    if (this.hoverHandle?.noteId === noteId) {
                        this.hideCard();
                    }
                });
        }, HOVER_OPEN_DELAY);
    }

    private scheduleClose(): void {
        if (this.openTimer !== null) {
            window.clearTimeout(this.openTimer);
            this.openTimer = null;
        }

        if (this.closeTimer !== null) {
            return;
        }

        this.closeTimer = window.setTimeout(() => {
            this.closeTimer = null;
            this.hideCard();
        }, HOVER_CLOSE_DELAY);
    }

    private cancelClose(): void {
        if (this.closeTimer !== null) {
            window.clearTimeout(this.closeTimer);
            this.closeTimer = null;
        }
    }

    private showCard(anchor: HTMLElement, snippet: NoteSnippet | null, loading: boolean): void {
        this.ensureCard();
        const card = this.hoverCard!;
        clear(card);

        if (loading || snippet === null) {
            card.appendChild(el('div', {class: 'hover-card-loading', text: 'loading…'}));
        } else {
            card.appendChild(el('div', {class: 'hover-card-title', text: snippet.title}));

            if (snippet.tags.length > 0) {
                card.appendChild(el('div', {class: 'hover-card-tags', text: snippet.tags.join(' · ')}));
            }

            card.appendChild(el('div', {class: 'hover-card-preview', text: snippet.preview}));
        }

        const rect = anchor.getBoundingClientRect();
        const pos = positionHoverCard(
            {left: rect.left, top: rect.top, bottom: rect.bottom},
            {width: window.innerWidth, height: window.innerHeight},
            {cardWidth: CARD_WIDTH, cardMaxHeight: CARD_MAX_HEIGHT}
        );

        card.style.left = `${pos.left}px`;
        card.style.top = `${pos.top}px`;
    }

    private ensureCard(): void {
        if (this.hoverCard !== null) {
            return;
        }

        const card = el('div', {
            class: 'hover-card',
            style: {position: 'fixed', width: `${CARD_WIDTH}px`, maxHeight: `${CARD_MAX_HEIGHT}px`}
        });

        card.addEventListener('mouseenter', () => this.cancelClose());
        card.addEventListener('mouseleave', () => this.scheduleClose());

        document.body.appendChild(card);
        this.hoverCard = card;
    }

    private hideCard(): void {
        if (this.hoverCard !== null) {
            this.hoverCard.remove();
            this.hoverCard = null;
        }
        this.hoverHandle = null;
    }
}