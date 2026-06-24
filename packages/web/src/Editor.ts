import type {Frontmatter, Note} from '@synaipse/core';
import {api} from './Api.js';
import {clear, el} from './Dom.js';
import {EditorToolbar} from './EditorToolbar.js';
import {MarkdownPreview, NoteSnippet} from './MarkdownPreview.js';
import {PersistentValue} from './Persistence.js';

const STORAGE_SHOW_PREVIEW = 'synaipse.editor.showPreview';

export interface EditorCallbacks {
    onSave: (input: {content: string; frontmatter: Frontmatter}) => Promise<void>;
    onCancel: () => void;
    resolveWikilink?: (title: string) => string | undefined;
    onWikilinkClick?: (noteId: string) => void;
    onUnresolvedClick?: (title: string) => void;
    fetchSnippet?: (noteId: string) => Promise<NoteSnippet>;
}

const today = (): string => new Date().toISOString().slice(0, 10);

const parseTagsInput = (raw: string): string[] => {
    return raw
        .split(/[,\n]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
};

const showPreviewStore = new PersistentValue<boolean>(STORAGE_SHOW_PREVIEW, true);

// Below this viewport width the split-view leaves both panes too narrow
// to be useful; we switch to a single-pane tabbed layout instead. Chosen
// to give each pane at least ~400-450px when an editor sits next to the
// left+right sidebars (~250px each on the standard layout).
const TAB_MODE_BREAKPOINT_PX = 900;

export class Editor {
    public readonly element: HTMLElement;
    private note: Note;
    private title: string;
    private tagsInput: string;
    private content: string;
    private saving = false;
    private error: string | null = null;
    private showPreview: boolean;

    private titleInput!: HTMLInputElement;
    private tagsField!: HTMLInputElement;
    private textarea!: HTMLTextAreaElement;
    private splitContainer!: HTMLElement;
    private editorPane!: HTMLElement;
    private previewHost!: HTMLElement;
    private actionsHost!: HTMLElement;
    private errorHost!: HTMLElement;
    private tabBar!: HTMLElement;
    private tabWriteBtn!: HTMLButtonElement;
    private tabPreviewBtn!: HTMLButtonElement;
    private toolbar!: EditorToolbar;
    private preview: MarkdownPreview;
    private previewUnsubscribe: () => void;
    private mqMobile: MediaQueryList;
    private viewMode: 'split' | 'tab';
    private activeTab: 'write' | 'preview' = 'write';
    private onMqChange: (e: MediaQueryListEvent) => void;

    public constructor(note: Note, private readonly cb: EditorCallbacks) {
        this.note = note;
        this.title = this.initialTitle();
        this.tagsInput = this.initialTags();
        this.content = note.content;
        this.showPreview = showPreviewStore.get();

        this.mqMobile = window.matchMedia(`(max-width: ${TAB_MODE_BREAKPOINT_PX}px)`);
        this.viewMode = this.mqMobile.matches ? 'tab' : 'split';

        this.preview = new MarkdownPreview({
            ...(cb.resolveWikilink ? {resolveWikilink: cb.resolveWikilink} : {}),
            ...(cb.onWikilinkClick ? {onWikilinkClick: this.wikilinkClickGuard()} : {}),
            ...(cb.onUnresolvedClick ? {onUnresolvedClick: this.unresolvedClickGuard()} : {}),
            ...(cb.fetchSnippet ? {fetchSnippet: cb.fetchSnippet} : {})
        });

        this.element = el('div', {class: 'editor'});
        this.build();
        this.preview.update(this.content);

        this.previewUnsubscribe = showPreviewStore.subscribe((show) => {
            this.showPreview = show;
            this.applyLayout();
        });

        this.onMqChange = (e: MediaQueryListEvent) => {
            this.viewMode = e.matches ? 'tab' : 'split';
            this.applyLayout();
        };
        this.mqMobile.addEventListener('change', this.onMqChange);
    }

    public update(note: Note): void {
        this.note = note;
        this.title = this.initialTitle();
        this.tagsInput = this.initialTags();
        this.content = note.content;
        this.error = null;
        this.titleInput.value = this.title;
        this.tagsField.value = this.tagsInput;
        this.textarea.value = this.content;
        this.renderError();
        this.preview.update(this.content);
    }

    public destroy(): void {
        this.previewUnsubscribe();
        this.mqMobile.removeEventListener('change', this.onMqChange);
        this.preview.destroy();
        this.toolbar.destroy();
    }

    private initialTitle(): string {
        return typeof this.note.frontmatter.title === 'string'
            ? this.note.frontmatter.title
            : this.note.title;
    }

    private initialTags(): string {
        return Array.isArray(this.note.frontmatter.tags)
            ? this.note.frontmatter.tags.join(', ')
            : this.note.tags.join(', ');
    }

    public get isDirty(): boolean {
        return (
            this.title !== this.initialTitle()
            || this.tagsInput !== this.initialTags()
            || this.content !== this.note.content
        );
    }

    private wikilinkClickGuard(): (noteId: string) => void {
        return (noteId) => {
            if (noteId === this.note.id) {
                return;
            }

            if (this.isDirty && !window.confirm('You have unsaved changes. Discard and follow the link?')) {
                return;
            }

            this.cb.onWikilinkClick?.(noteId);
        };
    }

    private unresolvedClickGuard(): (title: string) => void {
        return (title) => {
            if (this.isDirty && !window.confirm('You have unsaved changes. Discard and create the new note?')) {
                return;
            }

            this.cb.onUnresolvedClick?.(title);
        };
    }

    private build(): void {
        this.titleInput = el('input', {
            attrs: {type: 'text', value: this.title},
            on: {input: (e) => { this.title = (e.target as HTMLInputElement).value; }}
        }) as HTMLInputElement;

        this.tagsField = el('input', {
            attrs: {type: 'text', value: this.tagsInput},
            on: {input: (e) => { this.tagsInput = (e.target as HTMLInputElement).value; }}
        }) as HTMLInputElement;

        const fields = el('div', {class: 'editor-fields'},
            el('label', {class: 'field'},
                el('span', {text: 'Title'}),
                this.titleInput
            ),
            el('label', {class: 'field'},
                el('span', {}, 'Tags ', el('em', {text: '(comma separated)'})),
                this.tagsField
            )
        );

        this.textarea = el('textarea', {
            class: 'editor-body',
            attrs: {spellcheck: 'false'},
            on: {
                input: (e) => {
                    this.content = (e.target as HTMLTextAreaElement).value;
                    this.preview.update(this.content);
                },
                dragover: (e) => this.onDragOver(e as DragEvent),
                dragleave: () => this.textarea.classList.remove('drop-target'),
                drop: (e) => void this.onDrop(e as DragEvent),
                paste: (e) => void this.onPaste(e as ClipboardEvent)
            }
        }) as HTMLTextAreaElement;
        this.textarea.value = this.content;

        this.toolbar = new EditorToolbar({
            textarea: this.textarea,
            onChange: (value) => {
                this.content = value;
                this.preview.update(value);
            }
        });

        this.editorPane = el('div', {class: 'editor-pane'}, this.toolbar.element, this.textarea);

        this.previewHost = this.preview.element;
        this.splitContainer = el('div',
            {class: this.showPreview ? 'editor-split' : 'editor-split single'},
            this.editorPane,
            this.previewHost
        );

        this.tabWriteBtn = el('button', {
            class: 'editor-tab-btn',
            attrs: {type: 'button'},
            text: 'Write',
            on: {click: () => this.setActiveTab('write')}
        }) as HTMLButtonElement;

        this.tabPreviewBtn = el('button', {
            class: 'editor-tab-btn',
            attrs: {type: 'button'},
            text: 'Preview',
            on: {click: () => this.setActiveTab('preview')}
        }) as HTMLButtonElement;

        this.tabBar = el('div', {class: 'editor-tabs', attrs: {role: 'tablist'}},
            this.tabWriteBtn,
            this.tabPreviewBtn
        );

        this.errorHost = el('div', {class: 'editor-error', style: {display: 'none'}});

        const saveBtn = el('button', {
            class: 'btn btn-primary',
            attrs: {type: 'button'},
            text: 'Save',
            on: {click: () => void this.save(saveBtn)}
        });

        const cancelBtn = el('button', {
            class: 'btn',
            attrs: {type: 'button'},
            text: 'Cancel',
            on: {click: () => this.cb.onCancel()}
        });

        const previewToggle = el('label', {class: 'preview-toggle'},
            el('input', {
                attrs: {type: 'checkbox', ...(this.showPreview ? {checked: 'checked'} : {})},
                on: {change: (e) => {
                    const next = (e.target as HTMLInputElement).checked;
                    showPreviewStore.set(next);
                }}
            }),
            'preview'
        );

        this.actionsHost = el('div', {class: 'editor-actions'}, saveBtn, cancelBtn, previewToggle);

        this.element.appendChild(fields);
        this.element.appendChild(this.tabBar);
        this.element.appendChild(this.splitContainer);
        this.element.appendChild(this.errorHost);
        this.element.appendChild(this.actionsHost);

        this.applyLayout();
    }

    private setActiveTab(tab: 'write' | 'preview'): void {
        if (this.activeTab === tab) return;
        this.activeTab = tab;
        this.applyLayout();
    }

    /**
     * Single source of truth for visibility of the two panes.
     * Two orthogonal inputs drive the layout:
     *   - `viewMode` ('split' on wide viewports, 'tab' below the
     *     breakpoint) — set by the media query listener.
     *   - `showPreview` (user toggle in the actions bar) — only
     *     consulted in split mode; in tab mode the user picks a tab
     *     instead, so the toggle is hidden.
     */
    private applyLayout(): void {
        const isTab = this.viewMode === 'tab';
        this.element.classList.toggle('tab-mode', isTab);
        this.splitContainer.classList.toggle('tab-mode', isTab);
        this.tabBar.style.display = isTab ? '' : 'none';

        if (isTab) {
            this.splitContainer.className = 'editor-split single tab-mode';
            const showWrite = this.activeTab === 'write';
            this.editorPane.style.display = showWrite ? '' : 'none';
            this.previewHost.style.display = showWrite ? 'none' : '';
            this.tabWriteBtn.classList.toggle('active', showWrite);
            this.tabPreviewBtn.classList.toggle('active', !showWrite);
            return;
        }

        this.splitContainer.className = this.showPreview ? 'editor-split' : 'editor-split single';
        this.editorPane.style.display = '';
        this.previewHost.style.display = this.showPreview ? '' : 'none';
    }

    private renderError(): void {
        if (this.error === null) {
            this.errorHost.style.display = 'none';
            clear(this.errorHost);
            return;
        }

        this.errorHost.style.display = '';
        this.errorHost.textContent = this.error;
    }

    private setSaving(saving: boolean, saveBtn: HTMLButtonElement): void {
        this.saving = saving;
        saveBtn.disabled = saving;
        saveBtn.textContent = saving ? 'Saving…' : 'Save';
        this.titleInput.disabled = saving;
        this.tagsField.disabled = saving;
        this.textarea.disabled = saving;
    }

    private flashSaved(saveBtn: HTMLButtonElement): void {
        saveBtn.textContent = 'Saved ✓';
        saveBtn.classList.add('btn-saved');

        window.setTimeout(() => {
            saveBtn.textContent = 'Save';
            saveBtn.classList.remove('btn-saved');
        }, 1200);
    }

    private async save(saveBtn: HTMLElement): Promise<void> {
        if (this.saving) {
            return;
        }

        const btn = saveBtn as HTMLButtonElement;
        this.setSaving(true, btn);
        this.error = null;
        this.renderError();

        try {
            const tags = parseTagsInput(this.tagsInput);
            const frontmatter: Frontmatter = {
                ...this.note.frontmatter,
                title: this.title,
                tags,
                updated: today()
            };

            if (typeof frontmatter.created !== 'string') {
                frontmatter.created = today();
            }

            await this.cb.onSave({content: this.content, frontmatter});
            this.setSaving(false, btn);
            this.flashSaved(btn);
            return;
        } catch (e) {
            this.error = e instanceof Error ? e.message : String(e);
            this.renderError();
            this.setSaving(false, btn);
        }
    }

    private onDragOver(event: DragEvent): void {
        if (event.dataTransfer === null) return;

        const hasFile = Array.from(event.dataTransfer.items).some((i) => i.kind === 'file');

        if (!hasFile) return;

        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        this.textarea.classList.add('drop-target');
    }

    private async onDrop(event: DragEvent): Promise<void> {
        this.textarea.classList.remove('drop-target');

        if (event.dataTransfer === null) return;

        const files = Array.from(event.dataTransfer.files).filter((f) => f.type.startsWith('image/'));

        if (files.length === 0) return;

        event.preventDefault();
        await this.uploadAndInsert(files);
    }

    private async onPaste(event: ClipboardEvent): Promise<void> {
        if (event.clipboardData === null) return;

        const files: File[] = [];
        for (const item of event.clipboardData.items) {
            if (item.kind === 'file') {
                const f = item.getAsFile();
                if (f !== null && f.type.startsWith('image/')) files.push(f);
            }
        }

        if (files.length === 0) return;

        event.preventDefault();
        await this.uploadAndInsert(files);
    }

    private async uploadAndInsert(files: File[]): Promise<void> {
        const inserts: string[] = [];

        for (const file of files) {
            try {
                const result = await api.uploadAsset(this.note.id, file);
                const alt = file.name.replace(/\.[^.]+$/, '');
                inserts.push(`![${alt}](${result.relativePath})`);
            } catch (e) {
                this.error = `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
                this.renderError();
                return;
            }
        }

        const insertion = inserts.join('\n\n');
        const start = this.textarea.selectionStart;
        const end = this.textarea.selectionEnd;
        const before = this.textarea.value.slice(0, start);
        const after = this.textarea.value.slice(end);

        this.textarea.value = `${before}${insertion}${after}`;
        this.content = this.textarea.value;
        this.preview.update(this.content);

        const cursor = start + insertion.length;
        this.textarea.selectionStart = cursor;
        this.textarea.selectionEnd = cursor;
        this.textarea.focus();
    }
}