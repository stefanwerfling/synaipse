import {el} from './Dom.js';
import {defineMessages, tc} from './I18n.js';
import {openModal} from './Modal.js';

const t = defineMessages('floorplanDialog', {
    loading: 'Loading mdfloor…',
    loadFailed: 'Could not load mdfloor: {message}',
    apply: 'Apply',
    applyHint: 'Apply (Ctrl+Enter)',
    editTitle: 'Edit floor plan',
    insertTitle: 'Insert floor plan'
});

/**
 * Modal wrapper around mdfloor's `mountEditor` for inserting or editing
 * `::: floorplan` blocks from the note editor toolbar. mdfloor is
 * dynamic-imported so the initial JS bundle stays lean — the dialog opens
 * with a loading placeholder and swaps in the editor once the module has
 * arrived.
 *
 * The dialog is intentionally dumb about placement: it takes an initial
 * DSL body and calls `onConfirm(body)` with the edited body. The caller
 * (EditorToolbar) decides whether that means inserting a fresh
 * `::: floorplan\n…\n:::` at the cursor or replacing an existing block.
 */

export interface FloorplanDialogOptions {
    initial: string;
    onConfirm: (dsl: string) => void;
    onCancel?: () => void;
}

// Note content inserted into the document (data, not UI text).
const DEFAULT_TEMPLATE = `@title Neuer Grundriss
@scale 55
@grid 0.5

room Raum 0,0 4x3
  door N 1 1`;

export const openFloorplanDialog = (opts: FloorplanDialogOptions): void => {
    const {initial, onConfirm} = opts;

    const stage = el('div', {class: 'floorplan-modal-stage'},
        el('div', {class: 'floorplan-modal-loading', attrs: {role: 'status'}, text: t('loading')})
    );

    // The confirm handler is captured under a mutable ref so the OK button
    // can call the "not ready yet" no-op until the editor mount has finished
    // and swapped in the real getSource-based capture.
    let confirmSource: () => string | null = () => null;

    const confirm = (): void => {
        const src = confirmSource();
        if (src === null) return;
        modal.close();
        onConfirm(src);
    };

    const cancelBtn = el('button', {
        class: 'btn',
        attrs: {type: 'button'},
        text: tc('cancel'),
        on: {click: () => {
            modal.close();
            opts.onCancel?.();
        }}
    });
    const okBtn = el('button', {
        class: 'btn btn-primary',
        attrs: {type: 'button', title: t('applyHint'), 'aria-keyshortcuts': 'Control+Enter'},
        text: t('apply'),
        on: {click: confirm}
    }) as HTMLButtonElement;
    okBtn.disabled = true;

    const modal = openModal({
        title: initial.length > 0 ? t('editTitle') : t('insertTitle'),
        icon: '🏠',
        closeLabel: tc('close'),
        size: 'full',
        className: 'floorplan-modal',
        body: stage,
        footer: [cancelBtn, okBtn],
        initialFocus: cancelBtn,
        onSubmitShortcut: confirm,
        onDismiss: () => opts.onCancel?.()
    });

    void (async () => {
        let mdfloor: typeof import('mdfloor');
        try {
            mdfloor = await import('mdfloor');
        } catch (e) {
            stage.replaceChildren(el('div', {
                class: 'floorplan-modal-error',
                attrs: {role: 'alert'},
                text: t('loadFailed', {message: e instanceof Error ? e.message : String(e)})
            }));
            return;
        }

        stage.replaceChildren();
        const editor = mdfloor.mountEditor(stage, {
            initial: initial.length > 0 ? initial : DEFAULT_TEMPLATE
        });

        confirmSource = () => editor.getSource();
        okBtn.disabled = false;
        okBtn.focus();
    })();
};
