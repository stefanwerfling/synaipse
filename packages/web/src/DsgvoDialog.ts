import {clear, el} from './Dom.js';

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

const CATEGORIES: readonly KindCategory[] = [
    {
        title: 'Kontakt',
        options: [
            {kind: 'name', label: 'Name', icon: '👤'},
            {kind: 'email', label: 'E-Mail', icon: '✉️'},
            {kind: 'phone', label: 'Telefon', icon: '📞'},
            {kind: 'address', label: 'Adresse', icon: '🏠'}
        ]
    },
    {
        title: 'Finanz',
        options: [
            {kind: 'iban', label: 'IBAN', icon: '🏦'},
            {kind: 'bic', label: 'BIC', icon: '🏦'},
            {kind: 'creditcard', label: 'Kreditkarte', icon: '💳'},
            {kind: 'tax-id', label: 'Steuer-ID', icon: '🧾'}
        ]
    },
    {
        title: 'Auth / Secrets',
        options: [
            {kind: 'password', label: 'Passwort', icon: '🔑'},
            {kind: 'jwt', label: 'JWT', icon: '🔐'},
            {kind: 'api-key', label: 'API-Key', icon: '🗝️'}
        ]
    },
    {
        title: 'Identifier',
        options: [
            {kind: 'ssn', label: 'SSN', icon: '🆔'},
            {kind: 'personalausweis', label: 'Personalausweis', icon: '🪪'},
            {kind: 'birthdate', label: 'Geburtsdatum', icon: '🎂'},
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

    const backdrop = el('div', {class: 'dsgvo-modal-backdrop'});
    const box = el('div', {class: 'dsgvo-modal'});

    const heading = el('div', {class: 'dsgvo-modal-heading'},
        el('span', {class: 'dsgvo-modal-lock', text: '🔒'}),
        el('span', {text: 'DSGVO-Marker setzen'})
    );

    const preview = el('div', {class: 'dsgvo-modal-preview'});
    const renderPreview = (): void => {
        clear(preview);
        const kind = selectedKind === CUSTOM_KIND ? (customKind.trim() || 'custom') : selectedKind;
        preview.appendChild(el('span', {class: 'dsgvo-preview-label', text: 'Ergebnis:'}));
        preview.appendChild(el('code', {class: 'dsgvo-preview-marker', text: buildDsgvoMarker(kind, selection)}));
    };

    const selectionBox = el('div', {class: 'dsgvo-modal-selection'},
        el('span', {class: 'dsgvo-modal-selection-label', text: 'Markiert:'}),
        el('code', {class: 'dsgvo-modal-selection-text', text: selection})
    );

    const categoriesHost = el('div', {class: 'dsgvo-modal-categories'});
    const radios: HTMLInputElement[] = [];

    for (const cat of CATEGORIES) {
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
                el('span', {class: 'dsgvo-modal-option-icon', text: opt.icon}),
                el('span', {class: 'dsgvo-modal-option-label', text: opt.label})
            ));
        }

        categoriesHost.appendChild(group);
    }

    const customField = el('input', {
        class: 'dsgvo-modal-custom-field',
        attrs: {type: 'text', placeholder: 'z.B. patient-id, vertragsnr, …', maxlength: 32},
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
        el('legend', {text: 'Custom'}),
        el('label', {class: 'dsgvo-modal-option'},
            customRadio,
            el('span', {class: 'dsgvo-modal-option-icon', text: '✏️'}),
            el('span', {class: 'dsgvo-modal-option-label', text: 'Freies Label'})
        ),
        customField
    );
    categoriesHost.appendChild(customGroup);

    const err = el('div', {class: 'dsgvo-modal-error', style: {display: 'none'}});

    const dismiss = (): void => {
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
        opts.onCancel?.();
    };
    const onKey = (ev: KeyboardEvent): void => {
        if (ev.key === 'Escape') dismiss();
        else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) confirm();
    };

    const confirm = (): void => {
        let kind: string;
        if (selectedKind === CUSTOM_KIND) {
            const trimmed = customKind.trim().toLowerCase();
            if (!KIND_RE.test(trimmed)) {
                err.textContent = 'Custom-Label: nur a-z, 0-9, - und _ (max 32).';
                err.style.display = 'block';
                return;
            }
            kind = trimmed;
        } else {
            kind = selectedKind;
        }

        document.removeEventListener('keydown', onKey);
        backdrop.remove();
        onConfirm(buildDsgvoMarker(kind, selection));
    };

    const cancelBtn = el('button', {
        class: 'btn',
        attrs: {type: 'button'},
        text: 'Abbrechen',
        on: {click: dismiss}
    });
    const okBtn = el('button', {
        class: 'btn btn-primary',
        attrs: {type: 'button'},
        text: 'Marker einsetzen',
        on: {click: confirm}
    });
    const actions = el('div', {class: 'dsgvo-modal-actions'}, cancelBtn, okBtn);

    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (ev) => {
        if (ev.target === backdrop) dismiss();
    });

    box.appendChild(heading);
    box.appendChild(selectionBox);
    box.appendChild(categoriesHost);
    box.appendChild(preview);
    box.appendChild(err);
    box.appendChild(actions);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    renderPreview();
    (radios.find((r) => r.checked) ?? radios[0])?.focus();
};