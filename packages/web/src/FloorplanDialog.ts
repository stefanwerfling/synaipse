import {el} from './Dom.js';

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

const DEFAULT_TEMPLATE = [
    '@title Neuer Grundriss',
    '@scale 55',
    '@grid 0.5',
    '',
    'room Raum 0,0 4x3',
    '  door N 1 1'
].join('\n');

export const openFloorplanDialog = (opts: FloorplanDialogOptions): void => {
    const {initial, onConfirm} = opts;

    const backdrop = el('div', {class: 'floorplan-modal-backdrop'});
    const box = el('div', {class: 'floorplan-modal'});

    const heading = el('div', {class: 'floorplan-modal-heading'},
        el('span', {class: 'floorplan-modal-icon', text: '🏠'}),
        el('span', {text: initial.length > 0 ? 'Grundriss bearbeiten' : 'Grundriss einfügen'})
    );

    const stage = el('div', {class: 'floorplan-modal-stage'},
        el('div', {class: 'floorplan-modal-loading', text: 'mdfloor lädt …'})
    );

    // The confirm handler is captured under a mutable ref so the OK button
    // can call the "not ready yet" no-op until the editor mount has finished
    // and swapped in the real getSource-based capture.
    let confirmSource: () => string | null = () => null;

    const dismiss = (): void => {
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
        opts.onCancel?.();
    };

    const confirm = (): void => {
        const src = confirmSource();
        if (src === null) return;
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
        onConfirm(src);
    };

    const onKey = (ev: KeyboardEvent): void => {
        if (ev.key === 'Escape') {
            dismiss();
        } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
            ev.preventDefault();
            confirm();
        }
    };

    const cancelBtn = el('button', {
        class: 'btn',
        attrs: {type: 'button'},
        text: 'Abbrechen',
        on: {click: dismiss}
    });
    const okBtn = el('button', {
        class: 'btn btn-primary',
        attrs: {type: 'button', title: 'Übernehmen (Ctrl+Enter)'},
        text: 'Übernehmen',
        on: {click: confirm}
    }) as HTMLButtonElement;
    okBtn.disabled = true;

    const actions = el('div', {class: 'floorplan-modal-actions'}, cancelBtn, okBtn);

    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (ev) => {
        if (ev.target === backdrop) dismiss();
    });

    box.appendChild(heading);
    box.appendChild(stage);
    box.appendChild(actions);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    void (async () => {
        let mdfloor: typeof import('mdfloor');
        try {
            mdfloor = await import('mdfloor');
        } catch (e) {
            stage.replaceChildren(el('div', {
                class: 'floorplan-modal-error',
                text: `mdfloor konnte nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`
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