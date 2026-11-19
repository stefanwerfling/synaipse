import {mountCardEditor} from './CardEditor.js';
import {clear, el, portalHost} from './Dom.js';
import {renderMarkdownInto} from './MarkdownPreview.js';

/**
 * In-place editors of the canvas (plan P7 / D2): the modal text-card
 * editor and the small label inputs for groups and edges.
 */

export interface LabelEditOptions {
    className: string;
    value: string;
    placeholder: string;
    /** World coordinates inside the stage, so the input scales with zoom. */
    left: number;
    top: number;
    /** Trimmed new value; only called when it differs from `value`. */
    onCommit: (next: string) => void;
}

/** Small text input on the stage. Enter/blur commit, Escape cancels; an empty value means "clear". */
export const openLabelEdit = (stage: HTMLElement, opts: LabelEditOptions): void => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = opts.className;
    input.value = opts.value;
    input.placeholder = opts.placeholder;
    input.style.left = `${opts.left}px`;
    input.style.top = `${opts.top}px`;

    stage.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (): void => {
        if (done) return;
        done = true;
        const next = input.value.trim();
        input.remove();
        if (next !== opts.value) opts.onCommit(next);
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            done = true;
            input.remove();
        }
    });
};

/**
 * Lift a text card out of the stage into a screen-fixed modal so the
 * writing area is roomy regardless of the card's size. The stored node
 * geometry is untouched — the `editing-modal` class switches to
 * position:fixed for the duration of the edit. Card and backdrop are
 * portalled into document.body because position:fixed inside the
 * transformed `.canvas-stage` would use the stage as containing block,
 * not the viewport.
 *
 * `onDone` gets the final text after the card is back on the stage and
 * its body re-rendered. Returns a teardown that force-commits.
 */
export const openTextCardEditor = (
    cardEl: HTMLElement | undefined,
    body: HTMLElement,
    text: string,
    onDone: (nextText: string) => void
): (() => void) => {
    const cardParent = cardEl?.parentElement ?? null;
    const cardNextSibling = cardEl?.nextSibling ?? null;
    if (cardEl !== undefined) {
        cardEl.classList.add('editing-modal');
        portalHost().appendChild(cardEl);
    }
    const backdrop = el('div', {class: 'canvas-editing-backdrop'});
    portalHost().appendChild(backdrop);

    // Clicking the dimmed area behind the modal = commit. The editor's
    // blur handler already handles focus loss; this makes the target
    // explicit and preempts the focus race.
    backdrop.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        cardEl?.querySelector<HTMLElement>('.canvas-card-editor')?.blur();
    });

    const restoreCardToStage = (): void => {
        if (cardEl === undefined) return;
        cardEl.classList.remove('editing-modal');
        if (cardParent === null) return;
        if (cardNextSibling !== null && cardNextSibling.parentNode === cardParent) {
            cardParent.insertBefore(cardEl, cardNextSibling);
        } else {
            cardParent.appendChild(cardEl);
        }
    };

    const handle = mountCardEditor(body, text, {
        onCommit: (nextText) => {
            restoreCardToStage();
            backdrop.remove();
            clear(body);
            renderMarkdownInto(body, nextText);
            onDone(nextText);
        }
    });
    return () => handle.destroy();
};
