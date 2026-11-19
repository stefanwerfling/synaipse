import {el, portalHost} from './Dom.js';

/**
 * The one modal frame for small dialogs (plan P7 / C2, C4): a backdrop in
 * the portal layer with a `role="dialog"` box, `aria-modal`, a labelled
 * title, a focus trap, Escape and backdrop click to dismiss, and focus
 * back to where it was on close. Confirm, prompt and form dialogs build on
 * it; the larger dialogs (settings, preview, DSGVO, floorplan, import)
 * move onto it in a later slice.
 */

export interface ModalOptions {
    title: string;
    /** Content below the title: text or elements. */
    body?: string | HTMLElement | HTMLElement[];
    /** Buttons in the footer, in reading order. */
    footer?: HTMLElement[];
    /** Escape, backdrop click or close(): the dialog is gone afterwards. */
    onDismiss: () => void;
    /** Element to focus first; default the first focusable one. */
    initialFocus?: HTMLElement;
    /** Extra class on the dialog box. */
    className?: string;
}

export interface ModalHandle {
    readonly element: HTMLElement;
    /** Removes the dialog and gives focus back. Does not call onDismiss. Idempotent. */
    close(): void;
}

const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
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

let nextId = 0;

export const openModal = (opts: ModalOptions): ModalHandle => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = `synaipse-modal-${++nextId}`;

    const title = el('h2', {class: 'modal-title', attrs: {id: `${id}-title`}, text: opts.title});
    const body = el('div', {class: 'modal-body', attrs: {id: `${id}-body`}});
    if (typeof opts.body === 'string') {
        body.appendChild(el('p', {class: 'modal-text', text: opts.body}));
    } else if (Array.isArray(opts.body)) {
        body.append(...opts.body);
    } else if (opts.body !== undefined) {
        body.appendChild(opts.body);
    }

    const box = el('div', {
        class: `modal${opts.className !== undefined ? ` ${opts.className}` : ''}`,
        attrs: {role: 'dialog', 'aria-modal': 'true', tabindex: '-1', 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-body`}
    }, title, body);
    if (opts.footer !== undefined && opts.footer.length > 0) {
        box.appendChild(el('div', {class: 'modal-footer'}, ...opts.footer));
    }

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
        close();
        opts.onDismiss();
    };

    const onKey = (ev: KeyboardEvent): void => {
        // Only the topmost modal reacts (a confirm opened from a dialog).
        if (backdrop.nextElementSibling?.classList.contains('modal-backdrop') === true) return;
        if (ev.key === 'Escape') {
            ev.preventDefault();
            // Panels and dialogs underneath also listen for Escape on document.
            ev.stopImmediatePropagation();
            dismiss();
            return;
        }
        if (ev.key !== 'Tab') return;
        const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const current = items.indexOf(document.activeElement as HTMLElement);
        const next = wrapFocusIndex(current, items.length, ev.shiftKey);
        ev.preventDefault();
        if (next >= 0) items[next]!.focus();
    };

    backdrop.addEventListener('mousedown', (ev) => {
        if (ev.target === backdrop) dismiss();
    });
    document.addEventListener('keydown', onKey, true);

    portalHost().appendChild(backdrop);
    const first = opts.initialFocus ?? box.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? box).focus();

    return {element: box, close};
};
