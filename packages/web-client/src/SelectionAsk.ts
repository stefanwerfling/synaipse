import {el, portalHost} from './Dom.js';
import {defineMessages} from './I18n.js';

const t = defineMessages('selectionAsk', {
    ask: '↳ Ask about this'
});

export interface SelectionAskOptions {
    /** The element a selection must lie in (the note preview); null while none is shown. */
    host: () => HTMLElement | null;
    /** The open note; null when none is open. */
    noteId: () => string | null;
    onAsk: (noteId: string, selection: string) => void;
}

/**
 * "↳ Ask about this" (plan P7 / D2): a floating button above a text
 * selection in the note preview that hands the selection to the chat.
 * Document listeners are installed once on {@link attach} and removed
 * on {@link destroy}.
 */
export class SelectionAsk {
    private button: HTMLButtonElement | null = null;
    private readonly listeners = new AbortController();
    private attached = false;

    public constructor(private readonly opts: SelectionAskOptions) {}

    public attach(): void {
        if (this.attached) return;
        this.attached = true;

        const onUp = (): void => {
            const host = this.opts.host();
            if (host === null) return;
            window.setTimeout(() => this.show(host), 0);
        };

        const signal = this.listeners.signal;
        document.addEventListener('mouseup', onUp, {signal});
        document.addEventListener('keyup', onUp, {signal});
        document.addEventListener('selectionchange', () => {
            const sel = window.getSelection();
            if (sel === null || sel.toString().trim().length === 0) {
                this.hide();
            }
        }, {signal});
    }

    public destroy(): void {
        this.listeners.abort();
        if (this.button !== null) {
            this.button.remove();
            this.button = null;
        }
    }

    private show(host: HTMLElement): void {
        const sel = window.getSelection();
        if (sel === null) return;

        const text = sel.toString().trim();
        if (text.length < 4) {
            this.hide();
            return;
        }

        if (sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);

        // selection must be inside the preview host
        if (!host.contains(range.commonAncestorContainer)) {
            this.hide();
            return;
        }

        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        if (this.button === null) {
            this.button = el('button', {
                class: 'selection-action',
                attrs: {type: 'button'},
                text: t('ask'),
                on: {mousedown: (e) => e.preventDefault()}
            }) as HTMLButtonElement;
            portalHost().appendChild(this.button);
        }

        const btn = this.button;
        btn.onclick = (): void => {
            const noteId = this.opts.noteId();
            if (noteId === null) return;
            this.opts.onAsk(noteId, text);
            this.hide();
            const live = window.getSelection();
            if (live !== null) live.removeAllRanges();
        };

        const top = window.scrollY + rect.top - 40;
        const left = window.scrollX + rect.left + rect.width / 2 - 80;
        btn.style.top = `${Math.max(8, top)}px`;
        btn.style.left = `${Math.max(8, left)}px`;
        btn.style.display = 'block';
    }

    private hide(): void {
        if (this.button !== null) {
            this.button.style.display = 'none';
        }
    }
}
