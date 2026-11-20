import {clear, el} from './Dom.js';
import {defineMessages, tc} from './I18n.js';
import {openModal} from './Modal.js';

const t = defineMessages('dsgvoDialog', {
    contact: 'Contact',
    finance: 'Finance',
    secrets: 'Auth / secrets',
    identifiers: 'Identifiers',
    kindName: 'Name',
    kindEmail: 'Email',
    kindPhone: 'Phone',
    kindAddress: 'Address',
    kindIban: 'IBAN',
    kindBic: 'BIC',
    kindCreditCard: 'Credit card',
    kindTaxId: 'Tax ID',
    kindPassword: 'Password',
    kindJwt: 'JWT',
    kindApiKey: 'API key',
    kindSsn: 'SSN',
    kindIdCard: 'ID card',
    kindBirthdate: 'Date of birth',
    result: 'Result:',
    selected: 'Selected:',
    custom: 'Custom',
    customLabel: 'Custom label',
    customPlaceholder: 'e.g. patient-id, contract-no, …',
    customInvalid: 'Custom label: only a-z, 0-9, - and _ (max 32).',
    insert: 'Insert marker',
    insertHint: 'Insert marker (Ctrl+Enter)',
    title: 'Set GDPR marker'
});

/**
 * Modal dialog for wrapping a selected text span in a DSGVO/privacy
 * marker. The marker syntax `[[dsgvo:<kind>|<text>]]` piggybacks on the
 * existing wikilink transform in MarkdownPreview — the preview renders
 * it as a distinct "redacted" pill, and the LLM-side privacy filter in
 * `packages/service/src/Privacy.ts` reduces it to `[redact:<kind>]`
 * before any external-provider request goes out.
 *
 * Categories mirror the auto-detectors in `Privacy.ts` plus a few extra
 * free-form kinds (name, address, birthdate, custom) that automatic PII
 * scanning cannot infer.
 */

export interface DsgvoDialogOptions {
    selection: string;
    onConfirm: (marker: string) => void;
    onCancel?: () => void;
}

interface KindOption {
    kind: string;
    label: string;
    icon: string;
}

interface KindCategory {
    title: string;
    options: readonly KindOption[];
}

// Built per open so the labels follow the current language.
const categories = (): readonly KindCategory[] => [
    {
        title: t('contact'),
        options: [
            {kind: 'name', label: t('kindName'), icon: '👤'},
            {kind: 'email', label: t('kindEmail'), icon: '✉️'},
            {kind: 'phone', label: t('kindPhone'), icon: '📞'},
            {kind: 'address', label: t('kindAddress'), icon: '🏠'}
        ]
    },
    {
        title: t('finance'),
        options: [
            {kind: 'iban', label: t('kindIban'), icon: '🏦'},
            {kind: 'bic', label: t('kindBic'), icon: '🏦'},
            {kind: 'creditcard', label: t('kindCreditCard'), icon: '💳'},
            {kind: 'tax-id', label: t('kindTaxId'), icon: '🧾'}
        ]
    },
    {
        title: t('secrets'),
        options: [
            {kind: 'password', label: t('kindPassword'), icon: '🔑'},
            {kind: 'jwt', label: t('kindJwt'), icon: '🔐'},
            {kind: 'api-key', label: t('kindApiKey'), icon: '🗝️'}
        ]
    },
    {
        title: t('identifiers'),
        options: [
            {kind: 'ssn', label: t('kindSsn'), icon: '🆔'},
            {kind: 'personalausweis', label: t('kindIdCard'), icon: '🪪'},
            {kind: 'birthdate', label: t('kindBirthdate'), icon: '🎂'},
            {kind: 'ipv4', label: 'IPv4', icon: '🌐'},
            {kind: 'ipv6', label: 'IPv6', icon: '🌐'}
        ]
    }
];

const CUSTOM_KIND = 'custom';
const DEFAULT_KIND = 'email';
const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Build the marker string `[[dsgvo:<kind>|<text>]]`. `\r` gets dropped
 * because the marker must stay on a single line for the preview's
 * text-node wikilink walk to match it.
 */
export const buildDsgvoMarker = (kind: string, text: string): string => {
    const safeKind = kind.trim().toLowerCase();
    const safeText = text.replace(/\r/g, '').replace(/\n/g, ' ');
    return `[[dsgvo:${safeKind}|${safeText}]]`;
};

/**
 * Open the DSGVO dialog. Backdrop click / Escape / Cancel dismiss; the
 * OK button confirms and returns the wrapped marker via `onConfirm`.
 */
export const openDsgvoDialog = (opts: DsgvoDialogOptions): void => {
    const {selection, onConfirm} = opts;
    let selectedKind = DEFAULT_KIND;
    let customKind = '';

    const preview = el('div', {class: 'dsgvo-modal-preview'});
    const renderPreview = (): void => {
        clear(preview);
        const kind = selectedKind === CUSTOM_KIND ? (customKind.trim() || 'custom') : selectedKind;
        preview.appendChild(el('span', {class: 'dsgvo-preview-label', text: t('result')}));
        preview.appendChild(el('code', {class: 'dsgvo-preview-marker', text: buildDsgvoMarker(kind, selection)}));
    };

    const selectionBox = el('div', {class: 'dsgvo-modal-selection'},
        el('span', {class: 'dsgvo-modal-selection-label', text: t('selected')}),
        el('code', {class: 'dsgvo-modal-selection-text', text: selection})
    );

    const categoriesHost = el('div', {class: 'dsgvo-modal-categories'});
    const radios: HTMLInputElement[] = [];

    for (const cat of categories()) {
        const group = el('fieldset', {class: 'dsgvo-modal-category'},
            el('legend', {text: cat.title})
        );

        for (const opt of cat.options) {
            const radio = el('input', {
                attrs: {type: 'radio', name: 'dsgvo-kind', value: opt.kind},
                on: {change: () => {
                    selectedKind = opt.kind;
                    customField.disabled = true;
                    renderPreview();
                }}
            }) as HTMLInputElement;
            if (opt.kind === selectedKind) radio.checked = true;
            radios.push(radio);

            group.appendChild(el('label', {class: 'dsgvo-modal-option'},
                radio,
                el('span', {class: 'dsgvo-modal-option-icon', attrs: {'aria-hidden': 'true'}, text: opt.icon}),
                el('span', {class: 'dsgvo-modal-option-label', text: opt.label})
            ));
        }

        categoriesHost.appendChild(group);
    }

    const customField = el('input', {
        class: 'dsgvo-modal-custom-field',
        attrs: {type: 'text', placeholder: t('customPlaceholder'), maxlength: 32, 'aria-label': t('customLabel')},
        on: {input: (ev) => {
            customKind = (ev.target as HTMLInputElement).value;
            renderPreview();
        }}
    }) as HTMLInputElement;
    customField.disabled = true;

    const customRadio = el('input', {
        attrs: {type: 'radio', name: 'dsgvo-kind', value: CUSTOM_KIND},
        on: {change: () => {
            selectedKind = CUSTOM_KIND;
            customField.disabled = false;
            customField.focus();
            renderPreview();
        }}
    }) as HTMLInputElement;
    radios.push(customRadio);

    const customGroup = el('fieldset', {class: 'dsgvo-modal-category dsgvo-modal-category-custom'},
        el('legend', {text: t('custom')}),
        el('label', {class: 'dsgvo-modal-option'},
            customRadio,
            el('span', {class: 'dsgvo-modal-option-icon', attrs: {'aria-hidden': 'true'}, text: '✏️'}),
            el('span', {class: 'dsgvo-modal-option-label', text: t('customLabel')})
        ),
        customField
    );
    categoriesHost.appendChild(customGroup);

    const err = el('div', {class: 'dsgvo-modal-error', attrs: {'aria-live': 'polite'}});

    const confirm = (): void => {
        let kind: string;
        if (selectedKind === CUSTOM_KIND) {
            const trimmed = customKind.trim().toLowerCase();
            if (!KIND_RE.test(trimmed)) {
                err.textContent = t('customInvalid');
                customField.focus();
                return;
            }
            kind = trimmed;
        } else {
            kind = selectedKind;
        }

        modal.close();
        onConfirm(buildDsgvoMarker(kind, selection));
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
        attrs: {type: 'button', title: t('insertHint'), 'aria-keyshortcuts': 'Control+Enter'},
        text: t('insert'),
        on: {click: confirm}
    });

    renderPreview();
    const modal = openModal({
        title: t('title'),
        icon: '🔒',
        closeLabel: tc('close'),
        size: 'lg',
        className: 'dsgvo-modal',
        body: [selectionBox, categoriesHost, preview, err],
        footer: [cancelBtn, okBtn],
        initialFocus: radios.find((r) => r.checked) ?? radios[0]!,
        onSubmitShortcut: confirm,
        onDismiss: () => opts.onCancel?.()
    });
};
