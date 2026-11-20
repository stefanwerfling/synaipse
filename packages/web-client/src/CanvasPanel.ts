import type {CanvasDocument} from '@synaipse/core';
import {api, type CanvasSummary} from './Api.js';
import {CanvasRenderer} from './CanvasRenderer.js';
import {clear, el} from './Dom.js';
import {slugify} from './Wikilinks.js';
import {defineMessages} from './I18n.js';

const t = defineMessages('canvasPanel', {
    newTitle: 'Create a new .canvas file',
    newCanvas: '+ New canvas',
    namePlaceholder: 'Name…',
    nameLabel: 'Canvas name',
    canvases: 'Canvases',
    loadFailed: 'Could not load canvases: {error}',
    noCanvases: 'No .canvas files in vault',
    openFailed: 'Could not open {id}: {error}',
    inFolder: 'in {folder}/',
    exists: '"{path}" already exists',
    error: 'Error: {error}',
    saving: 'saving…',
    saved: 'saved ✓',
    saveFailed: 'save failed',
    pickTitle: 'Pick a canvas',
    pickHint: 'Select a canvas from the sidebar or click "+ New canvas".',
    loadingCanvas: 'loading canvas…'
});

export interface CanvasPanelOptions {
    onOpenNote: (noteId: string) => void;
}

const SAVE_DEBOUNCE_MS = 500;
const SAVE_INDICATOR_LINGER_MS = 1500;
const DEFAULT_CANVAS_FOLDER = 'Boards';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export class CanvasPanel {
    public readonly element: HTMLElement;
    private sidebar!: HTMLElement;
    private canvasList!: HTMLElement;
    private saveIndicator!: HTMLElement;
    private main!: HTMLElement;
    private canvases: CanvasSummary[] = [];
    private activeId: string | null = null;
    private renderer: CanvasRenderer | null = null;

    private saveTimer: number | null = null;
    private saveIndicatorTimer: number | null = null;
    private pendingDoc: CanvasDocument | null = null;

    private createRow!: HTMLElement;
    private createInput!: HTMLInputElement;
    private createHint!: HTMLElement;
    private createOpen = false;

    public constructor(private readonly opts: CanvasPanelOptions) {
        this.element = el('div', {class: 'canvas-panel'});
        this.build();
    }

    public async onShow(): Promise<void> {
        await this.loadCanvases();

        if (this.activeId === null && this.canvases.length > 0) {
            const first = this.canvases[0];
            if (first !== undefined) {
                await this.selectCanvas(first.id);
            }
        }

        this.renderer?.mount();
    }

    /**
     * Called by the App when the user tabs away from the canvas view.
     * The renderer's modal editor is portalled to document.body so
     * without this it would keep hovering over the next tab.
     */
    public onHide(): void {
        this.renderer?.stopEditing();
        this.flushSave();
    }

    public destroy(): void {
        this.flushSave();
        this.renderer?.destroy();
        this.renderer = null;
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        if (this.saveIndicatorTimer !== null) {
            window.clearTimeout(this.saveIndicatorTimer);
            this.saveIndicatorTimer = null;
        }
    }

    private build(): void {
        this.canvasList = el('ul', {class: 'canvas-list'});
        this.saveIndicator = el('div', {class: 'canvas-save-indicator', text: ''});

        const newBtn = el('button', {
            class: 'btn btn-primary',
            attrs: {type: 'button', title: t('newTitle')},
            text: t('newCanvas'),
            on: {click: () => this.openCreateRow()}
        });

        const toolbar = el('div', {class: 'canvas-toolbar'}, newBtn);

        this.createInput = el('input', {
            class: 'create-row-input',
            attrs: {type: 'text', placeholder: t('namePlaceholder'), 'aria-label': t('nameLabel')},
            on: {keydown: (e) => this.onCreateInputKey(e as KeyboardEvent)}
        }) as HTMLInputElement;
        this.createHint = el('div', {class: 'create-row-hint'});
        this.createRow = el('div', {class: 'create-row', attrs: {hidden: 'hidden'}},
            this.createHint,
            this.createInput
        );

        this.sidebar = el('aside', {class: 'canvas-sidebar'},
            el('div', {class: 'canvas-sidebar-head', text: t('canvases')}),
            toolbar,
            this.createRow,
            this.saveIndicator,
            this.canvasList
        );

        this.main = el('main', {class: 'canvas-main'});
        this.renderEmpty();

        this.element.appendChild(this.sidebar);
        this.element.appendChild(this.main);
    }

    private async loadCanvases(): Promise<void> {
        try {
            this.canvases = await api.listCanvases();
        } catch (e) {
            this.renderError(t('loadFailed', {error: e instanceof Error ? e.message : String(e)}));
            return;
        }
        this.renderList();
    }

    private renderList(): void {
        clear(this.canvasList);

        if (this.canvases.length === 0) {
            this.canvasList.appendChild(el('li', {class: 'canvas-list-empty', text: t('noCanvases')}));
            return;
        }

        for (const c of this.canvases) {
            const item = el('li', {
                class: c.id === this.activeId ? 'canvas-list-item active' : 'canvas-list-item',
                attrs: {title: c.id},
                text: c.id,
                on: {click: () => void this.selectCanvas(c.id)}
            });
            this.canvasList.appendChild(item);
        }
    }

    private async selectCanvas(id: string): Promise<void> {
        if (this.activeId === id) return;

        // Flush any pending save for the previous canvas before switching,
        // otherwise the debounced write would land on the *new* selection.
        await this.flushSave();

        this.activeId = id;
        this.renderList();
        this.renderLoading();

        let doc: CanvasDocument;
        try {
            doc = await api.getCanvas(id);
        } catch (e) {
            this.renderError(t('openFailed', {id, error: e instanceof Error ? e.message : String(e)}));
            return;
        }

        this.renderCanvas(doc);
    }

    private renderCanvas(doc: CanvasDocument): void {
        this.renderer?.destroy();
        this.renderer = null;
        clear(this.main);

        this.renderer = new CanvasRenderer(doc, {
            onOpenNote: this.opts.onOpenNote,
            onOpenLink: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
            onChange: (updated) => this.scheduleSave(updated),
            editable: true
        });
        this.main.appendChild(this.renderer.element);
        this.renderer.mount();
    }

    private openCreateRow(): void {
        this.createOpen = true;
        this.createHint.classList.remove('create-row-hint-error');
        this.createHint.textContent = t('inFolder', {folder: DEFAULT_CANVAS_FOLDER});
        this.createInput.value = '';
        this.createRow.removeAttribute('hidden');
        window.requestAnimationFrame(() => {
            this.createInput.focus();
            this.createInput.select();
        });
    }

    private closeCreateRow(): void {
        this.createOpen = false;
        this.createRow.setAttribute('hidden', 'hidden');
        this.createInput.value = '';
        this.createHint.classList.remove('create-row-hint-error');
    }

    private onCreateInputKey(ev: KeyboardEvent): void {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            void this.commitCreateRow();
        } else if (ev.key === 'Escape') {
            ev.preventDefault();
            this.closeCreateRow();
        }
    }

    private async commitCreateRow(): Promise<void> {
        if (!this.createOpen) return;

        const raw = this.createInput.value.trim();
        if (raw.length === 0) return;

        const nameOnly = raw.replace(/\.canvas$/i, '');
        const slug = slugify(nameOnly) || 'untitled';
        const path = `${DEFAULT_CANVAS_FOLDER}/${slug}.canvas`;

        if (this.canvases.some((c) => c.id === path)) {
            this.createHint.textContent = t('exists', {path});
            this.createHint.classList.add('create-row-hint-error');
            return;
        }

        try {
            await api.putCanvas(path, {nodes: [], edges: []});
        } catch (e) {
            this.createHint.textContent = t('error', {error: e instanceof Error ? e.message : String(e)});
            this.createHint.classList.add('create-row-hint-error');
            return;
        }

        this.closeCreateRow();
        await this.loadCanvases();
        await this.selectCanvas(path);
    }

    private scheduleSave(doc: CanvasDocument): void {
        // Snapshot the doc so a burst of drag events collapses to one PUT.
        // We store the freshest one; the timer keeps rolling until it fires.
        this.pendingDoc = doc;
        this.setSaveStatus('saving');

        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
        }
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.flushSave();
        }, SAVE_DEBOUNCE_MS);
    }

    private async flushSave(): Promise<void> {
        if (this.pendingDoc === null || this.activeId === null) return;

        const doc = this.pendingDoc;
        const id = this.activeId;
        this.pendingDoc = null;

        try {
            await api.putCanvas(id, doc);
            this.setSaveStatus('saved');
            // Update mtime in-place instead of re-fetching the full list.
            for (const c of this.canvases) {
                if (c.id === id) c.mtime = Date.now();
            }
        } catch (e) {
            this.setSaveStatus('error');
            console.error('canvas save failed', e);
        }
    }

    private setSaveStatus(status: SaveStatus): void {
        this.saveIndicator.className = `canvas-save-indicator ${status}`;

        if (status === 'idle') {
            this.saveIndicator.textContent = '';
            return;
        }

        this.saveIndicator.textContent =
            status === 'saving' ? t('saving') :
            status === 'saved' ? t('saved') :
            t('saveFailed');

        // Auto-clear "saved" and "error" so the sidebar doesn't feel noisy.
        if (this.saveIndicatorTimer !== null) window.clearTimeout(this.saveIndicatorTimer);
        if (status === 'saved' || status === 'error') {
            this.saveIndicatorTimer = window.setTimeout(() => {
                this.setSaveStatus('idle');
                this.saveIndicatorTimer = null;
            }, SAVE_INDICATOR_LINGER_MS);
        }
    }

    private renderEmpty(): void {
        clear(this.main);
        this.main.appendChild(el('div', {class: 'canvas-empty'},
            el('div', {class: 'canvas-empty-title', text: t('pickTitle')}),
            el('div', {class: 'canvas-empty-hint', text: t('pickHint')})
        ));
    }

    private renderLoading(): void {
        clear(this.main);
        this.main.appendChild(el('p', {class: 'loading', text: t('loadingCanvas')}));
    }

    private renderError(message: string): void {
        clear(this.main);
        this.main.appendChild(el('p', {class: 'editor-error', text: message}));
    }
}