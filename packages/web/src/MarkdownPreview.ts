import {marked} from 'marked';
import {clear, el} from './Dom.js';
import {positionHoverCard} from './HoverCard.js';
import {splitWikilinkTarget} from './Wikilinks.js';

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
    private hoverCard: HTMLElement | null = null;
    private hoverHandle: HoverHandle | null = null;
    private openTimer: number | null = null;
    private closeTimer: number | null = null;

    public constructor(private readonly opts: MarkdownPreviewOptions = {}) {
        this.element = el('div', {class: 'md-preview'});
    }

    public update(content: string): void {
        if (content === this.content) {
            return;
        }

        this.content = content;
        this.render();
    }

    public destroy(): void {
        this.clearTimers();
        this.hideCard();
    }

    private render(): void {
        clear(this.element);
        this.element.innerHTML = renderMarkdown(this.content);
        this.transformWikilinks();
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