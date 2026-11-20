import {el} from './Dom.js';
import {defineMessages, tc} from './I18n.js';
import {openModal} from './Modal.js';

/**
 * Promise-based replacements for window.confirm / window.prompt (plan P7 /
 * C2). Native dialogs block the whole page — in an embedding host (PKG
 * Studio) every other module too — ignore the theme and can't be styled
 * or labelled. These run in the shared modal frame instead.
 *
 * Button labels default to the shared Cancel / OK in the UI language.
 */

const t = defineMessages('dialogs', {
    invalidProject: 'Invalid project name: only a-z, 0-9, . _ -'
});

export interface ConfirmOptions {
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** Destructive action: red confirm button, focus starts on Cancel. */
    danger?: boolean;
}

/** Resolves true on confirm, false on cancel, Escape or backdrop click. */
export const confirmDialog = (opts: ConfirmOptions): Promise<boolean> => new Promise((resolve) => {
    const cancel = el('button', {class: 'btn', attrs: {type: 'button'}, text: opts.cancelLabel ?? tc('cancel')});
    const ok = el('button', {
        class: opts.danger === true ? 'btn btn-danger' : 'btn btn-primary',
        attrs: {type: 'button'},
        text: opts.confirmLabel ?? tc('ok')
    });
    const modal = openModal({
        title: opts.title,
        ...(opts.message !== undefined ? {body: opts.message} : {}),
        footer: [cancel, ok],
        initialFocus: opts.danger === true ? cancel : ok,
        onDismiss: () => resolve(false)
    });
    cancel.addEventListener('click', () => {
        modal.close();
        resolve(false);
    });
    ok.addEventListener('click', () => {
        modal.close();
        resolve(true);
    });
});

export interface FormField {
    name: string;
    label: string;
    value?: string;
    placeholder?: string;
    type?: 'text' | 'password' | 'number' | 'url';
    autocomplete?: string;
}

export interface FormOptions {
    title: string;
    message?: string;
    fields: FormField[];
    confirmLabel?: string;
    cancelLabel?: string;
    /**
     * Checked on submit with the trimmed values (passwords untrimmed):
     * a message keeps the dialog open and shows it, null accepts.
     */
    validate?: (values: Record<string, string>) => string | null;
}

/** Field values on submit (Enter or the confirm button), null on cancel. */
export const formDialog = (opts: FormOptions): Promise<Record<string, string> | null> => new Promise((resolve) => {
    const form = el('form', {class: 'modal-form', attrs: {novalidate: 'true'}});
    const inputs = new Map<string, HTMLInputElement>();
    for (const f of opts.fields) {
        const input = el('input', {
            class: 'modal-input',
            attrs: {
                type: f.type ?? 'text',
                name: f.name,
                ...(f.placeholder !== undefined ? {placeholder: f.placeholder} : {}),
                ...(f.autocomplete !== undefined ? {autocomplete: f.autocomplete} : {}),
                ...(f.type === 'number' ? {step: 'any'} : {})
            }
        });
        input.value = f.value ?? '';
        inputs.set(f.name, input);
        form.appendChild(el('label', {class: 'modal-field'}, el('span', {class: 'modal-label', text: f.label}), input));
    }
    const error = el('div', {class: 'modal-error', attrs: {'aria-live': 'polite'}});
    form.appendChild(error);
    // Hidden submit so Enter in any field submits.
    form.appendChild(el('button', {attrs: {type: 'submit', hidden: 'true', tabindex: '-1'}}));

    const body: HTMLElement[] = [];
    if (opts.message !== undefined) body.push(el('p', {class: 'modal-text', text: opts.message}));
    body.push(form);

    const cancel = el('button', {class: 'btn', attrs: {type: 'button'}, text: opts.cancelLabel ?? tc('cancel')});
    const ok = el('button', {class: 'btn btn-primary', attrs: {type: 'button'}, text: opts.confirmLabel ?? tc('ok')});
    const first = inputs.get(opts.fields[0]?.name ?? '');
    const modal = openModal({
        title: opts.title,
        body,
        footer: [cancel, ok],
        ...(first !== undefined ? {initialFocus: first} : {}),
        onDismiss: () => resolve(null)
    });
    first?.select();

    const submit = (): void => {
        const values: Record<string, string> = {};
        for (const f of opts.fields) {
            const raw = inputs.get(f.name)!.value;
            values[f.name] = f.type === 'password' ? raw : raw.trim();
        }
        const problem = opts.validate?.(values) ?? null;
        if (problem !== null) {
            error.textContent = problem;
            return;
        }
        modal.close();
        resolve(values);
    };
    form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        submit();
    });
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => {
        modal.close();
        resolve(null);
    });
});

export interface PromptOptions extends Omit<FormOptions, 'fields' | 'validate'> {
    label?: string;
    value?: string;
    placeholder?: string;
    type?: FormField['type'];
    validate?: (value: string) => string | null;
}

/** One-field formDialog: the trimmed value, or null on cancel. */
export const promptDialog = async (opts: PromptOptions): Promise<string | null> => {
    const {label, value, placeholder, type, validate, ...rest} = opts;
    const values = await formDialog({
        ...rest,
        fields: [{
            name: 'value',
            label: label ?? '',
            ...(value !== undefined ? {value} : {}),
            ...(placeholder !== undefined ? {placeholder} : {}),
            ...(type !== undefined ? {type} : {})
        }],
        ...(validate !== undefined ? {validate: (v) => validate(v.value!)} : {})
    });
    return values === null ? null : values.value!;
};

/** Validator for roadmap / benchmark project names (a-z, 0-9, . _ -). */
export const validProjectName = (name: string): string | null =>
    name === '' || /^[A-Za-z0-9_.-]+$/.test(name) ? null : t('invalidProject');
