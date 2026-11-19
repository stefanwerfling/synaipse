import {el} from './Dom.js';
import {openModal, type ModalHandle} from './Modal.js';

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
                'Du sendest gleich an einen ',
                el('strong', {text: 'externen'}),
                ' LLM-Provider: ',
                el('code', {text: summary.provider}),
                '. Synaipse hat das Folgende vorbereitet:'
            );

            const stats = el('ul', {class: 'preview-stats'});

            if (summary.filteredPrivate > 0) {
                stats.appendChild(el('li', {},
                    el('span', {class: 'preview-stat-icon', attrs: {'aria-hidden': 'true'}, text: '🔒'}),
                    ` ${summary.filteredPrivate} Notiz${summary.filteredPrivate === 1 ? '' : 'en'} wurde${summary.filteredPrivate === 1 ? '' : 'n'} ausgeblendet (Privacy-Marker)`
                ));
            }

            const redactTotal = summary.redactions.reduce((sum, r) => sum + r.count, 0);

            if (redactTotal > 0) {
                const detail = summary.redactions.map((r) => `${r.count} ${r.kind}`).join(', ');
                stats.appendChild(el('li', {},
                    el('span', {class: 'preview-stat-icon', attrs: {'aria-hidden': 'true'}, text: '🛡'}),
                    ` ${redactTotal} PII/Secret-Treffer werden automatisch geschwärzt: `,
                    el('span', {class: 'preview-stat-detail', text: detail})
                ));
            }

            if (summary.filteredPrivate === 0 && redactTotal === 0) {
                stats.appendChild(el('li', {class: 'preview-stat-empty', text: 'Keine Privacy-relevanten Treffer in der aktuellen Source-Selektion.'}));
            }

            const skipInput = el('input', {
                class: 'preview-skip-input',
                attrs: {type: 'checkbox'}
            }) as HTMLInputElement;

            const skipRow = el('label', {class: 'preview-skip'},
                skipInput,
                el('span', {text: 'Künftig nicht mehr nachfragen (kann in den Browser-Daten zurückgesetzt werden).'})
            );

            const cancelBtn = el('button', {
                class: 'btn',
                attrs: {type: 'button'},
                text: 'Abbrechen',
                on: {click: dismiss}
            });

            const sendBtn = el('button', {
                class: 'btn btn-primary',
                attrs: {type: 'button'},
                text: 'Trotzdem senden',
                on: {click: () => this.settle?.({confirmed: true, rememberSkip: skipInput.checked})}
            }) as HTMLButtonElement;

            this.modal = openModal({
                title: 'DSGVO-Vorschau vor dem Senden',
                closeLabel: 'Schließen',
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