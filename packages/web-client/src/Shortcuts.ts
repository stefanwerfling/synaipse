import {el} from './Dom.js';
import {defineMessages, tc} from './I18n.js';
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

const t = defineMessages('shortcuts', {
    title: 'Keyboard shortcuts',
    everywhere: 'Everywhere',
    palette: 'Command palette: commands, tabs, notes',
    search: 'Focus the search field',
    overview: 'This overview',
    escape: 'Close dialog, palette or menu',
    back: 'Back to the previous view (browser history)',
    dialogs: 'Dialogs',
    nextField: 'Next field (stays inside the dialog)',
    confirm: 'Confirm (GDPR marker, floorplan)',
    editor: 'Note editor',
    bold: 'Bold',
    italic: 'Italic',
    code: 'Inline code',
    link: 'Insert link (inside the editor)',
    gdpr: 'Mark selection as GDPR-sensitive'
});

/** The shortcut list in the current UI language. */
export const shortcutGroups = (): readonly ShortcutGroup[] => [
    {
        title: t('everywhere'),
        items: [
            {keys: ['Ctrl', 'K'], label: t('palette')},
            {keys: ['/'], label: t('search')},
            {keys: ['?'], label: t('overview')},
            {keys: ['Esc'], label: t('escape')},
            {keys: ['Alt', '←'], label: t('back')}
        ]
    },
    {
        title: t('dialogs'),
        items: [
            {keys: ['Tab'], label: t('nextField')},
            {keys: ['Ctrl', 'Enter'], label: t('confirm')}
        ]
    },
    {
        title: t('editor'),
        items: [
            {keys: ['Ctrl', 'B'], label: t('bold')},
            {keys: ['Ctrl', 'I'], label: t('italic')},
            {keys: ['Ctrl', 'E'], label: t('code')},
            {keys: ['Ctrl', 'K'], label: t('link')},
            {keys: ['Ctrl', 'Shift', 'D'], label: t('gdpr')}
        ]
    }
];

const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export const openShortcutsDialog = (): void => {
    const mac = isMac();
    const body = shortcutGroups().map((group) => el('section', {class: 'shortcuts-group'},
        el('h3', {class: 'shortcuts-title', text: group.title}),
        el('dl', {class: 'shortcuts-list'},
            ...group.items.flatMap((item) => [
                el('dt', {class: 'shortcuts-keys'},
                    ...item.keys.map((k) => el('kbd', {text: mac && k === 'Ctrl' ? '⌘' : k}))),
                el('dd', {class: 'shortcuts-label', text: item.label})
            ])
        )
    ));
    const close = el('button', {class: 'btn btn-primary', attrs: {type: 'button'}, text: tc('close')});
    const modal = openModal({
        title: t('title'),
        closeLabel: tc('close'),
        size: 'md',
        className: 'shortcuts-dialog',
        body,
        footer: [close],
        initialFocus: close,
        onDismiss: () => undefined
    });
    close.addEventListener('click', () => modal.close());
};
