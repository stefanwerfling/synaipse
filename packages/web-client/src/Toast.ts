import {el, portalHost} from './Dom.js';

/**
 * Non-blocking notices (plan P7 / C2) for what used to be window.alert:
 * errors, results, hints. A stack in the bottom-right corner of the portal
 * layer; errors are announced assertively (`role="alert"`), the rest
 * politely. Each toast closes itself, on click of ×, or when it is pushed
 * out by newer ones.
 */

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastOptions {
    kind?: ToastKind;
    /** ms until it closes; 0 keeps it until closed. Default 4 s, errors 8 s. */
    durationMs?: number;
}

/** At most this many toasts at once; the oldest goes first. */
export const MAX_TOASTS = 4;

export const toastDuration = (kind: ToastKind, durationMs: number | undefined): number =>
    durationMs ?? (kind === 'error' ? 8000 : 4000);

const stack = (): HTMLElement => {
    const host = portalHost();
    const existing = host.querySelector<HTMLElement>(':scope > .toast-stack');
    if (existing !== null) return existing;
    const created = el('div', {class: 'toast-stack', attrs: {'aria-live': 'polite'}});
    host.appendChild(created);
    return created;
};

/** Shows a toast; returns a function that closes it early. */
export const toast = (message: string, opts: ToastOptions = {}): (() => void) => {
    const kind = opts.kind ?? 'info';
    const container = stack();

    const close = (): void => {
        if (timer !== null) clearTimeout(timer);
        item.remove();
    };
    const item = el('div', {class: `toast toast-${kind}`, attrs: kind === 'error' ? {role: 'alert'} : {role: 'status'}},
        el('span', {class: 'toast-text', text: message}),
        el('button', {class: 'toast-close', attrs: {type: 'button', 'aria-label': 'Close'}, text: '×', on: {click: close}})
    );
    container.appendChild(item);
    while (container.children.length > MAX_TOASTS) container.firstElementChild?.remove();

    const duration = toastDuration(kind, opts.durationMs);
    const timer = duration > 0 ? setTimeout(close, duration) : null;
    return close;
};

/** The usual error toast: `prefix: message of the cause`. */
export const toastError = (prefix: string, cause: unknown): void => {
    const detail = cause instanceof Error ? cause.message : String(cause);
    toast(prefix === '' ? detail : `${prefix}: ${detail}`, {kind: 'error'});
};
