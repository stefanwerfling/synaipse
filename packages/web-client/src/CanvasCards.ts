import type {CanvasDocument, CanvasNode} from '@synaipse/core';
import {api} from './Api.js';
import {clear, el} from './Dom.js';
import {renderMarkdownInto} from './MarkdownPreview.js';
import {resolveColor, SIDES} from './CanvasGeometry.js';
import {defineMessages, tc} from './I18n.js';

const t = defineMessages('canvasCards', {
    noteMissing: '(note not found in vault)',
    resize: 'Resize',
    dragEdge: 'Drag to create edge ({side})',
    top: 'top',
    right: 'right',
    bottom: 'bottom',
    left: 'left'
});

/**
 * DOM for canvas cards and group frames (plan P7 / D2). Every element
 * carries `data-node-id`; the renderer's pointer handlers route on that
 * plus `data-role` (`text-body`, `resize`, `anchor`).
 */

const placeBox = (node: CanvasNode): Record<string, string> => ({
    left: `${node.x}px`,
    top: `${node.y}px`,
    width: `${node.width}px`,
    height: `${node.height}px`
});

/**
 * OneNote-style tint: the element's background shifts toward the picked
 * colour, border matches, and children can inherit via `var(--card-color)`.
 * `data-color` is the flag CSS rules key on so the untinted default stays clean.
 */
const tint = (target: HTMLElement, color: string | undefined): void => {
    const accent = resolveColor(color, '');
    if (accent.length === 0) return;
    target.style.setProperty('--card-color', accent);
    target.dataset.color = '1';
};

/** Rebuild all group frames into `host`; returns the id → element map. */
export const renderGroups = (host: HTMLElement, doc: CanvasDocument, selected: ReadonlySet<string>): Map<string, HTMLElement> => {
    clear(host);
    const els = new Map<string, HTMLElement>();

    for (const node of doc.nodes) {
        if (node.type !== 'group') continue;

        const rect = el('div', {
            class: selected.has(node.id) ? 'canvas-group selected' : 'canvas-group',
            style: placeBox(node)
        });
        rect.dataset.nodeId = node.id;
        tint(rect, node.color);

        if (node.label !== undefined && node.label.length > 0) {
            rect.appendChild(el('div', {class: 'canvas-group-label', text: node.label}));
        }

        host.appendChild(rect);
        els.set(node.id, rect);
    }
    return els;
};

export interface CardOptions {
    selected: ReadonlySet<string>;
    editable: boolean;
    onOpenLink: (url: string) => void;
}

/** Title plus a 320-char preview of the note, filled in asynchronously. */
const populateFileCard = (card: HTMLElement, fileId: string): void => {
    const title = el('div', {class: 'canvas-card-file-title', text: fileId});
    const preview = el('div', {class: 'canvas-card-file-preview', text: tc('loading')});

    card.appendChild(title);
    card.appendChild(preview);
    card.classList.add('canvas-card-clickable');

    void api.getNote(fileId).then((note) => {
        title.textContent = note.title;
        const snippet = note.content.slice(0, 320);
        preview.textContent = snippet + (note.content.length > 320 ? '…' : '');
    }).catch(() => {
        preview.textContent = t('noteMissing');
        preview.classList.add('canvas-card-file-missing');
    });
};

const buildCard = (node: CanvasNode, opts: CardOptions): HTMLElement => {
    const card = el('div', {class: `canvas-card canvas-card-${node.type}`, style: placeBox(node)});
    card.dataset.nodeId = node.id;
    tint(card, node.color);
    if (opts.selected.has(node.id)) card.classList.add('selected');

    if (node.type === 'text') {
        const body = el('div', {class: 'canvas-card-body md-preview'});
        body.dataset.role = 'text-body';
        renderMarkdownInto(body, node.text);
        card.appendChild(body);
    } else if (node.type === 'file') {
        populateFileCard(card, node.file);
    } else if (node.type === 'link') {
        card.appendChild(el('div', {class: 'canvas-card-link'},
            el('a', {
                attrs: {href: node.url, target: '_blank', rel: 'noopener noreferrer'},
                text: node.url,
                on: {click: (e) => {
                    e.preventDefault();
                    opts.onOpenLink(node.url);
                }}
            })
        ));
    }

    if (opts.editable) {
        const handle = el('div', {class: 'canvas-card-resize', attrs: {title: t('resize')}});
        handle.dataset.role = 'resize';
        card.appendChild(handle);

        // One anchor dot per card side, positioned via CSS. Group nodes
        // stay anchor-less — edges only connect real cards, matching
        // Obsidian's rules.
        for (const side of SIDES) {
            const anchor = el('div', {
                class: `canvas-card-anchor canvas-card-anchor-${side}`,
                attrs: {title: t('dragEdge', {side: t(side)})}
            });
            anchor.dataset.role = 'anchor';
            anchor.dataset.side = side;
            card.appendChild(anchor);
        }
    }

    return card;
};

/** Rebuild all non-group cards into `host`; returns the id → element map. */
export const renderCards = (host: HTMLElement, doc: CanvasDocument, opts: CardOptions): Map<string, HTMLElement> => {
    clear(host);
    const els = new Map<string, HTMLElement>();
    for (const node of doc.nodes) {
        if (node.type === 'group') continue;
        const card = buildCard(node, opts);
        host.appendChild(card);
        els.set(node.id, card);
    }
    return els;
};

/** The markdown body of a text card element, where the editor mounts. */
export const textBodyOf = (card: HTMLElement | undefined): HTMLElement | null =>
    card?.querySelector<HTMLElement>('[data-role="text-body"]') ?? null;
