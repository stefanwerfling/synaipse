import {el} from './Dom.js';
import {openModal} from './Modal.js';

/**
 * Keyboard shortcut overview (plan P7 / C1), opened with `?` or from the
 * command palette. The list is the reference: a new global shortcut
 * belongs here too.
 */
export interface ShortcutGroup {
    title: string;
    items: ReadonlyArray<{keys: readonly string[]; label: string}>;
}

export const SHORTCUTS: readonly ShortcutGroup[] = [
    {
        title: 'Everywhere',
        items: [
            {keys: ['Ctrl', 'K'], label: 'Command palette: commands, tabs, notes'},
            {keys: ['/'], label: 'Focus the search field'},
            {keys: ['?'], label: 'This overview'},
            {keys: ['Esc'], label: 'Close dialog, palette or menu'},
            {keys: ['Alt', '←'], label: 'Back to the previous view (browser history)'}
        ]
    },
    {
        title: 'Dialogs',
        items: [
            {keys: ['Tab'], label: 'Next field (stays inside the dialog)'},
            {keys: ['Ctrl', 'Enter'], label: 'Confirm (DSGVO marker, floorplan)'}
        ]
    },
    {
        title: 'Note editor',
        items: [
            {keys: ['Ctrl', 'B'], label: 'Bold'},
            {keys: ['Ctrl', 'I'], label: 'Italic'},
            {keys: ['Ctrl', 'E'], label: 'Inline code'},
            {keys: ['Ctrl', 'K'], label: 'Insert link (inside the editor)'},
            {keys: ['Ctrl', 'Shift', 'D'], label: 'Mark selection as DSGVO'}
        ]
    }
];

const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export const openShortcutsDialog = (): void => {
    const mac = isMac();
    const body = SHORTCUTS.map((group) => el('section', {class: 'shortcuts-group'},
        el('h3', {class: 'shortcuts-title', text: group.title}),
        el('dl', {class: 'shortcuts-list'},
            ...group.items.flatMap((item) => [
                el('dt', {class: 'shortcuts-keys'},
                    ...item.keys.map((k) => el('kbd', {text: mac && k === 'Ctrl' ? '⌘' : k}))),
                el('dd', {class: 'shortcuts-label', text: item.label})
            ])
        )
    ));
    const close = el('button', {class: 'btn btn-primary', attrs: {type: 'button'}, text: 'Close'});
    const modal = openModal({
        title: 'Keyboard shortcuts',
        closeLabel: 'Close',
        size: 'md',
        className: 'shortcuts-dialog',
        body,
        footer: [close],
        initialFocus: close,
        onDismiss: () => undefined
    });
    close.addEventListener('click', () => modal.close());
};
