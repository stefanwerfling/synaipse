import {importApi} from './Api.js';
import {
    buildImportPayload,
    buildPreviews,
    parseChatgptExport,
    type ChatgptConversationPreview,
    type ParsedExport
} from './ChatgptImport.js';
import {clear, el} from './Dom.js';

export interface ImportDialogCallbacks {
    onNotesChanged: () => void;
}

const formatDate = (unixSeconds: number): string => {
    if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return '—';
    const d = new Date(unixSeconds * 1000);
    return d.toISOString().slice(0, 10);
};

export class ImportDialog {
    public readonly element: HTMLElement;
    private overlay!: HTMLElement;
    private body!: HTMLElement;
    private parsed: ParsedExport | null = null;
    private previews: ChatgptConversationPreview[] = [];
    private existing: Record<string, string> = {};
    private selected = new Set<string>();
    private activePreview: string | null = null;
    private filter = '';
    private isOpen = false;
    private isImporting = false;

    public constructor(private readonly cb: ImportDialogCallbacks) {
        this.element = el('div', {class: 'import-dialog-host'});
    }

    public async open(): Promise<void> {
        if (this.isOpen) return;
        this.isOpen = true;

        try {
            this.existing = await importApi.listExisting();
        } catch (cause) {
            console.error('failed to load existing chatgpt imports', cause);
            this.existing = {};
        }

        this.overlay = el('div', {class: 'import-overlay'});

        const close = (): void => {
            if (this.isImporting) return;
            this.close();
        };

        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) close();
        });

        this.body = el('div', {class: 'import-dialog'});
        this.overlay.appendChild(this.body);
        document.body.appendChild(this.overlay);

        this.renderDropzone();
    }

    public close(): void {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.overlay.remove();
        this.parsed = null;
        this.previews = [];
        this.selected.clear();
        this.activePreview = null;
        this.filter = '';
    }

    private renderDropzone(): void {
        clear(this.body);

        const head = el('div', {class: 'import-head'},
            el('h2', {text: 'Import ChatGPT export'}),
            el('button', {
                class: 'import-close',
                attrs: {type: 'button', 'aria-label': 'close'},
                text: '×',
                on: {click: () => this.close()}
            })
        );

        const fileInput = el('input', {
            attrs: {type: 'file', accept: '.zip,application/zip'},
            style: {display: 'none'},
            on: {change: (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file !== undefined) void this.loadFile(file);
            }}
        }) as HTMLInputElement;

        const dz = el('div', {class: 'import-dropzone'},
            el('div', {class: 'import-dropzone-icon', text: '⬇'}),
            el('p', {class: 'import-dropzone-text', text: 'Drop your ChatGPT export ZIP here'}),
            el('p', {class: 'import-dropzone-hint', text: 'Or click to pick a file'}),
            fileInput
        );

        dz.addEventListener('click', () => fileInput.click());
        dz.addEventListener('dragover', (e) => {
            e.preventDefault();
            dz.classList.add('dragging');
        });
        dz.addEventListener('dragleave', () => dz.classList.remove('dragging'));
        dz.addEventListener('drop', (e) => {
            e.preventDefault();
            dz.classList.remove('dragging');
            const file = e.dataTransfer?.files[0];
            if (file !== undefined) void this.loadFile(file);
        });

        this.body.appendChild(head);
        this.body.appendChild(dz);
    }

    private async loadFile(file: File): Promise<void> {
        this.renderLoading(`Parsing ${file.name}…`);

        try {
            this.parsed = await parseChatgptExport(file);
            this.previews = buildPreviews(this.parsed);

            // Pre-select everything by default — easier to deselect a few than tick hundreds.
            this.selected = new Set(this.previews.map((p) => p.id));
            this.activePreview = this.previews[0]?.id ?? null;
            this.renderList();
        } catch (cause) {
            this.renderError(String(cause));
        }
    }

    private renderLoading(label: string): void {
        clear(this.body);
        this.body.appendChild(el('div', {class: 'import-loading', text: label}));
    }

    private renderError(message: string): void {
        clear(this.body);

        this.body.appendChild(el('div', {class: 'import-error'},
            el('h3', {text: 'Import failed'}),
            el('p', {text: message}),
            el('button', {
                class: 'btn',
                attrs: {type: 'button'},
                text: 'Pick another file',
                on: {click: () => this.renderDropzone()}
            })
        ));
    }

    private renderList(): void {
        clear(this.body);

        const head = el('div', {class: 'import-head'},
            el('h2', {text: `Import ChatGPT export · ${this.previews.length} conversations`}),
            el('button', {
                class: 'import-close',
                attrs: {type: 'button', 'aria-label': 'close'},
                text: '×',
                on: {click: () => this.close()}
            })
        );

        const filterInput = el('input', {
            class: 'import-filter',
            attrs: {type: 'text', placeholder: 'Filter by title…'},
            on: {input: (e) => {
                this.filter = (e.target as HTMLInputElement).value;
                this.renderListBody(listHost, previewHost);
            }}
        }) as HTMLInputElement;

        const selectAll = el('button', {
            class: 'btn',
            attrs: {type: 'button'},
            text: 'Select all',
            on: {click: () => {
                this.selected = new Set(this.filteredPreviews().map((p) => p.id));
                this.renderListBody(listHost, previewHost);
            }}
        });

        const selectNone = el('button', {
            class: 'btn',
            attrs: {type: 'button'},
            text: 'Clear',
            on: {click: () => {
                this.selected.clear();
                this.renderListBody(listHost, previewHost);
            }}
        });

        const toolbar = el('div', {class: 'import-toolbar'}, filterInput, selectAll, selectNone);

        const listHost = el('div', {class: 'import-list'});
        const previewHost = el('div', {class: 'import-preview'});

        const split = el('div', {class: 'import-split'}, listHost, previewHost);

        const importBtn = el('button', {
            class: 'btn btn-primary',
            attrs: {type: 'button'},
            text: 'Import',
            on: {click: () => void this.runImport(importBtn as HTMLButtonElement, statusLine)}
        }) as HTMLButtonElement;

        const statusLine = el('span', {class: 'import-status'});

        const footer = el('div', {class: 'import-footer'},
            statusLine,
            el('button', {
                class: 'btn',
                attrs: {type: 'button'},
                text: 'Cancel',
                on: {click: () => this.close()}
            }),
            importBtn
        );

        this.body.appendChild(head);
        this.body.appendChild(toolbar);
        this.body.appendChild(split);
        this.body.appendChild(footer);

        this.renderListBody(listHost, previewHost);
    }

    private filteredPreviews(): ChatgptConversationPreview[] {
        const q = this.filter.trim().toLowerCase();
        if (q.length === 0) return this.previews;
        return this.previews.filter((p) => p.title.toLowerCase().includes(q));
    }

    private renderListBody(listHost: HTMLElement, previewHost: HTMLElement): void {
        clear(listHost);
        const items = this.filteredPreviews();

        if (items.length === 0) {
            listHost.appendChild(el('div', {class: 'import-empty', text: 'No conversations match the filter.'}));
        }

        for (const p of items) {
            const isSelected = this.selected.has(p.id);
            const isExisting = this.existing[p.id] !== undefined;
            const isActive = this.activePreview === p.id;

            const row = el('div', {class: isActive ? 'import-row active' : 'import-row'},
                el('input', {
                    class: 'import-row-check',
                    attrs: {type: 'checkbox', ...(isSelected ? {checked: 'checked'} : {})},
                    on: {change: (e) => {
                        const checked = (e.target as HTMLInputElement).checked;
                        if (checked) this.selected.add(p.id);
                        else this.selected.delete(p.id);
                        this.renderListBody(listHost, previewHost);
                    }}
                }),
                el('div', {class: 'import-row-main'},
                    el('div', {class: 'import-row-title', text: p.title}),
                    el('div', {class: 'import-row-meta'},
                        el('span', {text: formatDate(p.updateTime)}),
                        el('span', {text: `${p.messageCount} msg`}),
                        ...(p.model !== null ? [el('span', {class: 'import-row-model', text: p.model})] : [])
                    )
                ),
                el('span', {
                    class: isExisting ? 'import-row-badge update' : 'import-row-badge new',
                    text: isExisting ? 'Update' : 'New'
                })
            );

            row.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).tagName === 'INPUT') return;
                this.activePreview = p.id;
                this.renderListBody(listHost, previewHost);
            });

            listHost.appendChild(row);
        }

        this.renderPreview(previewHost);
    }

    private renderPreview(host: HTMLElement): void {
        clear(host);

        if (this.activePreview === null) {
            host.appendChild(el('div', {class: 'import-empty', text: 'Pick a conversation to preview.'}));
            return;
        }

        const preview = this.previews.find((p) => p.id === this.activePreview);
        if (preview === undefined) return;

        const existingNote = this.existing[preview.id];

        host.appendChild(el('h3', {class: 'import-preview-title', text: preview.title}));

        host.appendChild(el('dl', {class: 'import-preview-meta'},
            el('dt', {text: 'Created'}), el('dd', {text: formatDate(preview.createTime)}),
            el('dt', {text: 'Updated'}), el('dd', {text: formatDate(preview.updateTime)}),
            el('dt', {text: 'Model'}), el('dd', {text: preview.model ?? '—'}),
            el('dt', {text: 'Messages'}), el('dd', {text: String(preview.messageCount)}),
            el('dt', {text: 'ChatGPT ID'}), el('dd', {text: preview.id}),
            ...(existingNote !== undefined
                ? [el('dt', {text: 'Existing note'}), el('dd', {text: existingNote})]
                : [])
        ));

        if (preview.excerpt.length > 0) {
            host.appendChild(el('div', {class: 'import-preview-excerpt-label', text: 'First user message'}));
            host.appendChild(el('div', {class: 'import-preview-excerpt', text: preview.excerpt}));
        }
    }

    private async runImport(button: HTMLButtonElement, status: HTMLElement): Promise<void> {
        if (this.parsed === null) return;
        if (this.selected.size === 0) {
            status.textContent = 'Select at least one conversation';
            return;
        }

        this.isImporting = true;
        button.disabled = true;

        const ids = [...this.selected];
        let done = 0;
        let failed = 0;
        let firstError: string | null = null;

        for (const id of ids) {
            done += 1;
            status.textContent = `${done}/${ids.length} · ${id.slice(0, 8)}…`;

            try {
                const payload = await buildImportPayload(this.parsed, id);
                if (payload === null) {
                    failed += 1;
                    if (firstError === null) firstError = `${id}: payload build returned null`;
                    continue;
                }
                await importApi.importConversation(payload);
            } catch (cause) {
                console.error(`import failed for ${id}`, cause);
                failed += 1;
                if (firstError === null) firstError = cause instanceof Error ? cause.message : String(cause);
            }
        }

        if (failed === 0) {
            status.textContent = `✓ Imported ${ids.length}`;
        } else {
            const summary = `Imported ${ids.length - failed} · ${failed} failed`;
            status.textContent = firstError === null
                ? summary
                : `${summary} — first error: ${firstError}`;
        }

        this.cb.onNotesChanged();
        this.isImporting = false;
        button.disabled = false;

        if (failed === 0) {
            window.setTimeout(() => this.close(), 1200);
        }
    }
}