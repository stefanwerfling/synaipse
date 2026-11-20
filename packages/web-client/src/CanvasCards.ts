import type {CanvasNode} from '@synaipse/core';
import {api} from './Api.js';
import {el} from './Dom.js';
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
 * carries `data-node-id`; the renderer places them on the jsNGraph
 * RectBoard (plan P10 / S6), which recognises the resize grip and the side
 * anchors by `data-rb` (`resize`, `anchor`). `data-role="text-body"` marks
 * where the text editor mounts.
 */

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

/** A group frame; its geometry is set by the board. */
export const buildGroup = (node: CanvasNode): HTMLElement => {
    const frame = el('div', {class: 'canvas-group'});
    frame.dataset.nodeId = node.id;
    tint(frame, node.color);
    if (node.type === 'group' && node.label !== undefined && node.label.length > 0) {
        frame.appendChild(el('div', {class: 'canvas-group-label', text: node.label}));
    }
    return frame;
};

export interface CardOptions {
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

/** A card (text, file or link); its geometry is set by the board. */
export const buildCard = (node: CanvasNode, opts: CardOptions): HTMLElement => {
    const card = el('div', {class: `canvas-card canvas-card-${node.type}`});
    card.dataset.nodeId = node.id;
    tint(card, node.color);

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
        handle.dataset.rb = 'resize';
        card.appendChild(handle);

        // One anchor dot per card side, positioned via CSS. Group nodes
        // stay anchor-less — edges only connect real cards, matching
        // Obsidian's rules.
        for (const side of SIDES) {
            const anchor = el('div', {
                class: `canvas-card-anchor canvas-card-anchor-${side}`,
                attrs: {title: t('dragEdge', {side: t(side)})}
            });
            anchor.dataset.rb = 'anchor';
            anchor.dataset.side = side;
            card.appendChild(anchor);
        }
    }

    return card;
};

/** The markdown body of a text card element, where the editor mounts. */
export const textBodyOf = (card: HTMLElement | undefined): HTMLElement | null =>
    card?.querySelector<HTMLElement>('[data-role="text-body"]') ?? null;
