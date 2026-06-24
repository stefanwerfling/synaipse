import {clear, el} from './Dom.js';

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
 * Pattern mirrors ImportDialog: overlay + dialog body, click-outside
 * closes. Returns a promise that resolves with the user's choice; the
 * caller awaits it before invoking /api/chat.
 */
export class PreviewDialog {
    private overlay: HTMLElement | null = null;

    public async open(summary: PreviewSummary): Promise<PreviewDialogResult> {
        return new Promise<PreviewDialogResult>((resolve) => {
            const overlay = el('div', {class: 'preview-overlay'});
            const body = el('div', {class: 'preview-dialog'});

            let result: PreviewDialogResult = {confirmed: false, rememberSkip: false};

            const settle = (next: PreviewDialogResult): void => {
                result = next;
                overlay.remove();
                this.overlay = null;
                resolve(result);
            };

            const dismiss = (): void => settle({confirmed: false, rememberSkip: false});

            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) dismiss();
            });

            // Esc closes too — modal etiquette.
            const onKey = (e: KeyboardEvent): void => {
                if (e.key === 'Escape') {
                    document.removeEventListener('keydown', onKey);
                    dismiss();
                }
            };
            document.addEventListener('keydown', onKey);

            // Head
            const head = el('div', {class: 'preview-head'},
                el('h2', {text: 'DSGVO-Vorschau vor dem Senden'}),
                el('button', {
                    class: 'preview-close',
                    attrs: {type: 'button', 'aria-label': 'close'},
                    text: '×',
                    on: {click: dismiss}
                })
            );

            // Lead paragraph
            const lead = el('p', {class: 'preview-lead'},
                'Du sendest gleich an einen ',
                el('strong', {text: 'externen'}),
                ' LLM-Provider: ',
                el('code', {text: summary.provider}),
                '. Synaipse hat das Folgende vorbereitet:'
            );

            // Stats list
            const stats = el('ul', {class: 'preview-stats'});

            if (summary.filteredPrivate > 0) {
                stats.appendChild(el('li', {},
                    el('span', {class: 'preview-stat-icon', text: '🔒'}),
                    ` ${summary.filteredPrivate} Notiz${summary.filteredPrivate === 1 ? '' : 'en'} wurde${summary.filteredPrivate === 1 ? '' : 'n'} ausgeblendet (Privacy-Marker)`
                ));
            }

            const redactTotal = summary.redactions.reduce((sum, r) => sum + r.count, 0);

            if (redactTotal > 0) {
                const detail = summary.redactions.map((r) => `${r.count} ${r.kind}`).join(', ');
                stats.appendChild(el('li', {},
                    el('span', {class: 'preview-stat-icon', text: '🛡'}),
                    ` ${redactTotal} PII/Secret-Treffer werden automatisch geschwärzt: `,
                    el('span', {class: 'preview-stat-detail', text: detail})
                ));
            }

            if (summary.filteredPrivate === 0 && redactTotal === 0) {
                stats.appendChild(el('li', {class: 'preview-stat-empty', text: 'Keine Privacy-relevanten Treffer in der aktuellen Source-Selektion.'}));
            }

            // Skip checkbox
            const skipInput = el('input', {
                class: 'preview-skip-input',
                attrs: {type: 'checkbox', id: 'preview-skip'}
            }) as HTMLInputElement;

            const skipRow = el('label', {
                class: 'preview-skip',
                attrs: {for: 'preview-skip'}
            },
                skipInput,
                el('span', {text: 'Künftig nicht mehr nachfragen (kann in den Browser-Daten zurückgesetzt werden).'})
            );

            // Footer
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
                on: {click: () => {
                    document.removeEventListener('keydown', onKey);
                    settle({confirmed: true, rememberSkip: skipInput.checked});
                }}
            }) as HTMLButtonElement;

            const footer = el('div', {class: 'preview-footer'}, cancelBtn, sendBtn);

            clear(body);
            body.appendChild(head);
            body.appendChild(lead);
            body.appendChild(stats);
            body.appendChild(skipRow);
            body.appendChild(footer);

            overlay.appendChild(body);
            document.body.appendChild(overlay);
            this.overlay = overlay;

            sendBtn.focus();
        });
    }

    public close(): void {
        if (this.overlay !== null) {
            this.overlay.remove();
            this.overlay = null;
        }
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