import type {Note} from '@synaipse/core';
import {tagColor} from './Colors.js';
import {el} from './Dom.js';
import {defineMessages, tc} from './I18n.js';

const t = defineMessages('noteToolbar', {
    more: 'More actions',
    summarize: 'Summarize',
    summarizeTitle: 'Generate an LLM summary of this note',
    history: 'History',
    historyTitle: 'Show change history',
    pdf: 'Export PDF',
    pdfTitle: 'Download this note as a nicely formatted PDF',
    deleteTitle: 'Delete this note'
});

export interface OverflowItem {
    label: string;
    title: string;
    danger?: boolean;
    onSelect: () => void;
}

/**
 * Overflow menu ("⋯") for secondary actions. The dropdown is anchored
 * to the trigger via a `position: relative` wrapper. Outside-click and
 * Escape close it; those listeners exist only while it is open. One
 * instance per viewer, so a re-render can dismiss a stale open menu.
 */
export class OverflowMenu {
    private closer: (() => void) | null = null;

    public build(items: readonly OverflowItem[]): HTMLElement {
        const menu = el('div', {class: 'viewer-overflow-menu', attrs: {role: 'menu'}});

        const wrap = el('div', {class: 'viewer-overflow'});

        const trigger = el('button', {
            class: 'btn btn-overflow',
            attrs: {type: 'button', 'aria-label': t('more'), 'aria-haspopup': 'menu', 'aria-expanded': 'false'},
            text: '⋯'
        }) as HTMLButtonElement;

        const close = (): void => {
            wrap.classList.remove('open');
            trigger.setAttribute('aria-expanded', 'false');
            document.removeEventListener('mousedown', onDocDown, true);
            document.removeEventListener('keydown', onKey, true);
            this.closer = null;
        };

        const onDocDown = (ev: MouseEvent): void => {
            if (!wrap.contains(ev.target as Node)) close();
        };
        const onKey = (ev: KeyboardEvent): void => {
            if (ev.key === 'Escape') close();
        };

        const open = (): void => {
            this.closer?.();
            wrap.classList.add('open');
            trigger.setAttribute('aria-expanded', 'true');
            document.addEventListener('mousedown', onDocDown, true);
            document.addEventListener('keydown', onKey, true);
            this.closer = close;
        };

        trigger.addEventListener('click', () => {
            if (wrap.classList.contains('open')) close();
            else open();
        });

        for (const item of items) {
            menu.appendChild(el('button', {
                class: item.danger === true ? 'viewer-overflow-item danger' : 'viewer-overflow-item',
                attrs: {type: 'button', role: 'menuitem', title: item.title},
                text: item.label,
                on: {click: () => {
                    close();
                    item.onSelect();
                }}
            }));
        }

        wrap.appendChild(trigger);
        wrap.appendChild(menu);
        return wrap;
    }

    public close(): void {
        this.closer?.();
    }
}

/**
 * Folder path as breadcrumb (`Memory › decisions › 2026-06-11-foo.md`).
 * Returns an empty container for root-level notes so the h1 sits flush
 * against the top of the head. The terminal segment is the file name
 * (useful because the title below is often different).
 */
export const buildBreadcrumb = (noteId: string): HTMLElement => {
    const parts = noteId.split('/').filter((p) => p.length > 0);

    if (parts.length <= 1) {
        return el('div', {class: 'viewer-breadcrumb empty'});
    }

    const host = el('div', {class: 'viewer-breadcrumb', attrs: {title: noteId}});

    parts.forEach((part, i) => {
        if (i > 0) {
            host.appendChild(el('span', {class: 'viewer-breadcrumb-sep', text: '›'}));
        }
        const isLast = i === parts.length - 1;
        host.appendChild(el('span', {
            class: isLast ? 'viewer-breadcrumb-part last' : 'viewer-breadcrumb-part',
            text: part
        }));
    });

    return host;
};

export interface NoteToolbarActions {
    /** Present only when chat is configured. */
    onSummarize?: () => void;
    /** Present only when history is configured. */
    onHistory?: () => void;
    onExportPdf: () => void;
    onEdit: () => void;
    onDelete: () => void;
}

/**
 * Head of the note viewer (plan P7 / D2): breadcrumb, title, the
 * primary actions (Export PDF, Edit) and the overflow menu, followed by
 * the tag chips when the note has tags.
 */
export const buildNoteHead = (note: Note, actions: NoteToolbarActions, overflow: OverflowMenu): HTMLElement[] => {
    const overflowItems: OverflowItem[] = [];

    if (actions.onSummarize !== undefined) {
        overflowItems.push({
            label: t('summarize'),
            title: t('summarizeTitle'),
            onSelect: actions.onSummarize
        });
    }

    if (actions.onHistory !== undefined) {
        overflowItems.push({
            label: t('history'),
            title: t('historyTitle'),
            onSelect: actions.onHistory
        });
    }

    overflowItems.push({
        label: t('pdf'),
        title: t('pdfTitle'),
        onSelect: actions.onExportPdf
    });

    overflowItems.push({
        label: tc('delete'),
        title: t('deleteTitle'),
        danger: true,
        onSelect: actions.onDelete
    });

    const exportBtn = el('button', {
        class: 'btn',
        attrs: {type: 'button'},
        text: t('pdf'),
        title: t('pdfTitle'),
        on: {click: actions.onExportPdf}
    });

    const editBtn = el('button', {
        class: 'btn',
        attrs: {type: 'button'},
        text: tc('edit'),
        on: {click: actions.onEdit}
    });

    const info = el('div', {class: 'viewer-head-info'},
        buildBreadcrumb(note.id),
        el('h1', {text: note.title})
    );

    const head = el('div', {class: 'viewer-head'},
        info,
        el('div', {class: 'viewer-actions'}, exportBtn, editBtn, overflow.build(overflowItems))
    );

    if (note.tags.length === 0) return [head];

    const tagHost = el('div', {class: 'viewer-tags'});

    for (const tag of note.tags) {
        const color = tagColor(tag);
        tagHost.appendChild(el('span', {
            class: 'viewer-tag',
            style: {borderColor: color, color}
        },
            el('span', {class: 'viewer-tag-swatch', style: {background: color}}),
            el('span', {class: 'viewer-tag-label', text: tag})
        ));
    }

    return [head, tagHost];
};
