import {el, portalHost} from './Dom.js';

/**
 * The one modal frame (plan P7 / C2, C4): a backdrop in the portal layer
 * with a `role="dialog"` box, `aria-modal`, a labelled title, a focus
 * trap, Escape and backdrop click to dismiss, and focus back to where it
 * was on close. Confirm, prompt and form dialogs build on it, and so do
 * the larger ones (settings, preview, DSGVO, floorplan, import, token,
 * summarize).
 *
 * Two layouts: `compact` (default) pads the whole box — small dialogs;
 * `sections` gives head, body and footer their own padding and dividers,
 * and the body scrolls — dialogs with lists or panels.
 */

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

export interface ModalOptions {
    title: string;
    /** Decorative glyph before the title (hidden from screen readers). */
    icon?: string;
    /** Second line under the title: text or an element that may change (status). */
    subtitle?: string | HTMLElement;
    /** Content below the title: text or elements. */
    body?: string | HTMLElement | HTMLElement[];
    /** Footer content in reading order (buttons, a status line). */
    footer?: HTMLElement[];
    /** Escape, backdrop click, × or close(): the dialog is gone afterwards. */
    onDismiss: () => void;
    /**
     * Asked before Escape, backdrop click or × dismiss; false keeps the
     * dialog open (an import that is still running).
     */
    canDismiss?: () => boolean;
    /** Ctrl/Cmd+Enter anywhere in the dialog. */
    onSubmitShortcut?: () => void;
    /** Shows a × button in the head with this accessible name. */
    closeLabel?: string;
    /** Element to focus first; default the first focusable one. */
    initialFocus?: HTMLElement;
    /** sm 440px (default), md 560, lg 720, xl 960, full 1280×92vh. */
    size?: ModalSize;
    layout?: 'compact' | 'sections';
    /** Extra class on the dialog box. */
    className?: string;
}

export interface ModalHandle {
    readonly element: HTMLElement;
    /** The body container; dialogs that re-render swap its children. */
    readonly body: HTMLElement;
    setTitle(text: string): void;
    /** Replaces the footer content; an empty list hides the footer. */
    setFooter(items: HTMLElement[]): void;
    /** Removes the dialog and gives focus back. Does not call onDismiss. Idempotent. */
    close(): void;
}

const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]'
].join(',');

/**
 * Next index for Tab / Shift+Tab inside a trap of `count` focusables,
 * wrapping at both ends. `current` -1 means focus is outside the list.
 */
export const wrapFocusIndex = (current: number, count: number, backwards: boolean): number => {
    if (count <= 0) return -1;
    if (current < 0) return backwards ? count - 1 : 0;
    return backwards ? (current - 1 + count) % count : (current + 1) % count;
};

/** The modal on top: the last backdrop in the portal layer (toasts may sit between). */
const isTopmost = (backdrop: HTMLElement): boolean => {
    const all = backdrop.parentElement?.querySelectorAll(':scope > .modal-backdrop');
    return all !== undefined && all[all.length - 1] === backdrop;
};

const isVisible = (node: HTMLElement): boolean => node.getClientRects().length > 0;

let nextId = 0;

export const openModal = (opts: ModalOptions): ModalHandle => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = `synaipse-modal-${++nextId}`;

    const titleText = el('span', {text: opts.title});
    const title = el('h2', {class: 'modal-title', attrs: {id: `${id}-title`}},
        ...(opts.icon !== undefined ? [el('span', {class: 'modal-icon', attrs: {'aria-hidden': 'true'}, text: opts.icon})] : []),
        titleText
    );
    const headMain = el('div', {class: 'modal-head-main'}, title);
    if (opts.subtitle !== undefined) {
        headMain.appendChild(typeof opts.subtitle === 'string'
            ? el('div', {class: 'modal-subtitle', text: opts.subtitle})
            : opts.subtitle);
    }
    const head = el('div', {class: 'modal-head'}, headMain);

    const body = el('div', {class: 'modal-body', attrs: {id: `${id}-body`}});
    if (typeof opts.body === 'string') {
        body.appendChild(el('p', {class: 'modal-text', text: opts.body}));
    } else if (Array.isArray(opts.body)) {
        body.append(...opts.body);
    } else if (opts.body !== undefined) {
        body.appendChild(opts.body);
    }

    const footer = el('div', {class: 'modal-footer'});

    const classes = ['modal', `modal-${opts.size ?? 'sm'}`];
    if (opts.layout === 'sections') classes.push('modal-sections');
    if (opts.className !== undefined) classes.push(opts.className);
    const box = el('div', {
        class: classes.join(' '),
        attrs: {role: 'dialog', 'aria-modal': 'true', tabindex: '-1', 'aria-labelledby': `${id}-title`}
    }, head, body, footer);
    // Long bodies (lists, panels) would be read out in full; only plain text describes.
    if (typeof opts.body === 'string') box.setAttribute('aria-describedby', `${id}-body`);

    const setFooter = (items: HTMLElement[]): void => {
        footer.replaceChildren(...items);
        footer.hidden = items.length === 0;
    };
    setFooter(opts.footer ?? []);

    const backdrop = el('div', {class: 'modal-backdrop'}, box);

    let closed = false;
    const close = (): void => {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        if (previous !== null && previous.isConnected) previous.focus();
    };
    const dismiss = (): void => {
        if (opts.canDismiss !== undefined && !opts.canDismiss()) return;
        close();
        opts.onDismiss();
    };

    if (opts.closeLabel !== undefined) {
        head.appendChild(el('button', {
            class: 'modal-close',
            attrs: {type: 'button', 'aria-label': opts.closeLabel, title: opts.closeLabel},
            text: '×',
            on: {click: dismiss}
        }));
    }

    const onKey = (ev: KeyboardEvent): void => {
        // Only the topmost modal reacts (a confirm opened from a dialog).
        if (!isTopmost(backdrop)) return;
        if (ev.key === 'Escape') {
            ev.preventDefault();
            // Panels and dialogs underneath also listen for Escape on document.
            ev.stopImmediatePropagation();
            dismiss();
            return;
        }
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && opts.onSubmitShortcut !== undefined) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            opts.onSubmitShortcut();
            return;
        }
        if (ev.key !== 'Tab') return;
        const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isVisible);
        const current = items.indexOf(document.activeElement as HTMLElement);
        const next = wrapFocusIndex(current, items.length, ev.shiftKey);
        ev.preventDefault();
        if (next >= 0) items[next]!.focus();
        else box.focus();
    };

    backdrop.addEventListener('mousedown', (ev) => {
        if (ev.target === backdrop) dismiss();
    });
    document.addEventListener('keydown', onKey, true);

    portalHost().appendChild(backdrop);
    // The × in the head is a poor first stop; start in the content.
    const first = opts.initialFocus
        ?? [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].find((n) => isVisible(n) && !n.classList.contains('modal-close'));
    (first ?? box).focus();

    return {
        element: box,
        body,
        setTitle: (text) => {
            titleText.textContent = text;
        },
        setFooter,
        close
    };
};
