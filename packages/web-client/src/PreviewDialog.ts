import {el} from './Dom.js';
import {openModal, type ModalHandle} from './Modal.js';
import {defineMessages, tc} from './I18n.js';

const t = defineMessages('previewDialog', {
    title: 'GDPR preview before sending',
    leadStart: 'You are about to send to an',
    external: 'external',
    leadMid: 'LLM provider:',
    leadEnd: '. Synaipse prepared the following:',
    hidden: '{count} note was hidden (privacy marker)|{count} notes were hidden (privacy marker)',
    redacted: '{count} PII/secret matches will be redacted automatically:',
    none: 'No privacy-relevant matches in the current source selection.',
    skip: 'Don’t ask again (can be reset in the browser data).',
    send: 'Send anyway'
});

export interface PreviewSummary {
    provider: string;
    filteredPrivate: number;
    redactions: ReadonlyArray<{kind: string; count: number}>;
}

export interface PreviewDialogResult {
    confirmed: boolean;
    rememberSkip: boolean;
}

/**
 * Last gate before vault content reaches an external LLM provider. Shown
 * once per browser (persistent localStorage skip flag) when the DSGVO
 * preview tally reports at least one private-note filter or one redaction
 * hit. The user either confirms (and optionally suppresses future prompts)
 * or cancels — the chat send is aborted on cancel and the input stays
 * populated so the user can edit and retry.
 *
 * Runs in the shared modal frame. Resolves with the user's choice; the
 * caller awaits it before invoking /api/chat.
 */
export class PreviewDialog {
    private modal: ModalHandle | null = null;
    private settle: ((result: PreviewDialogResult) => void) | null = null;

    public async open(summary: PreviewSummary): Promise<PreviewDialogResult> {
        return new Promise<PreviewDialogResult>((resolve) => {
            this.settle = (result): void => {
                this.modal?.close();
                this.modal = null;
                this.settle = null;
                resolve(result);
            };
            const dismiss = (): void => this.settle?.({confirmed: false, rememberSkip: false});

            const lead = el('p', {class: 'preview-lead'},
                `${t('leadStart')} `,
                el('strong', {text: t('external')}),
                ` ${t('leadMid')} `,
                el('code', {text: summary.provider}),
                t('leadEnd')
            );

            const stats = el('ul', {class: 'preview-stats'});

            if (summary.filteredPrivate > 0) {
                stats.appendChild(el('li', {},
                    el('span', {class: 'preview-stat-icon', attrs: {'aria-hidden': 'true'}, text: '🔒'}),
                    ` ${t('hidden', {count: summary.filteredPrivate})}`
                ));
            }

            const redactTotal = summary.redactions.reduce((sum, r) => sum + r.count, 0);

            if (redactTotal > 0) {
                const detail = summary.redactions.map((r) => `${r.count} ${r.kind}`).join(', ');
                stats.appendChild(el('li', {},
                    el('span', {class: 'preview-stat-icon', attrs: {'aria-hidden': 'true'}, text: '🛡'}),
                    ` ${t('redacted', {count: redactTotal})} `,
                    el('span', {class: 'preview-stat-detail', text: detail})
                ));
            }

            if (summary.filteredPrivate === 0 && redactTotal === 0) {
                stats.appendChild(el('li', {class: 'preview-stat-empty', text: t('none')}));
            }

            const skipInput = el('input', {
                class: 'preview-skip-input',
                attrs: {type: 'checkbox'}
            }) as HTMLInputElement;

            const skipRow = el('label', {class: 'preview-skip'},
                skipInput,
                el('span', {text: t('skip')})
            );

            const cancelBtn = el('button', {
                class: 'btn',
                attrs: {type: 'button'},
                text: tc('cancel'),
                on: {click: dismiss}
            });

            const sendBtn = el('button', {
                class: 'btn btn-primary',
                attrs: {type: 'button'},
                text: t('send'),
                on: {click: () => this.settle?.({confirmed: true, rememberSkip: skipInput.checked})}
            }) as HTMLButtonElement;

            this.modal = openModal({
                title: t('title'),
                closeLabel: tc('close'),
                size: 'md',
                layout: 'sections',
                className: 'preview-dialog',
                body: [lead, stats, skipRow],
                footer: [cancelBtn, sendBtn],
                initialFocus: sendBtn,
                onDismiss: () => {
                    this.modal = null;
                    dismiss();
                }
            });
        });
    }

    /** Closes the dialog as cancelled. */
    public close(): void {
        this.settle?.({confirmed: false, rememberSkip: false});
    }
}

const SKIP_KEY = 'synaipse-dsgvo-preview-skip';

export const previewSkipFlag = {
    isSet(): boolean {
        try {
            return window.localStorage.getItem(SKIP_KEY) === '1';
        } catch {
            return false;
        }
    },
    set(): void {
        try {
            window.localStorage.setItem(SKIP_KEY, '1');
        } catch {
            // ignore — localStorage disabled / quota
        }
    }
};