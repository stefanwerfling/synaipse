import type {Frontmatter, Note} from '@synaipse/core';
import {extractTypedLinks} from '@synaipse/core';
import {api} from './Api.js';
import {clear, el} from './Dom.js';
import {clearDraft, formatDraftAge, readDraft, writeDraft} from './Drafts.js';
import {EditorToolbar} from './EditorToolbar.js';
import {MarkdownPreview, NoteSnippet} from './MarkdownPreview.js';
import {PersistentValue} from './Persistence.js';
import {WikilinkAutocomplete, type WikilinkMatch} from './WikilinkAutocomplete.js';

const STORAGE_SHOW_PREVIEW = 'synaipse.editor.showPreview';

export interface EditorCallbacks {
    onSave: (input: {content: string; frontmatter: Frontmatter}) => Promise<void>;
    onCancel: () => void;
    resolveWikilink?: (title: string) => string | undefined;
    onWikilinkClick?: (noteId: string) => void;
    onUnresolvedClick?: (title: string) => void;
    fetchSnippet?: (noteId: string) => Promise<NoteSnippet>;
    /**
     * Fuzzy-search across note titles for the `[[` autocomplete popup.
     * If omitted, autocomplete is silently disabled.
     */
    searchTitles?: (query: string) => readonly WikilinkMatch[];
    /**
     * Fired whenever the dirty flag changes (title/tags/content edited or
     * reset). Also fired whenever a draft is written or cleared so the
     * host can refresh sidebar draft-markers without polling storage.
     */
    onDirtyChange?: (dirty: boolean) => void;
}

const DRAFT_DEBOUNCE_MS = 500;

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
    private autocomplete: WikilinkAutocomplete | null = null;
    private preview: MarkdownPreview;
    private previewUnsubscribe: () => void;
    private mqMobile: MediaQueryList;
    private viewMode: 'split' | 'tab';
    private activeTab: 'write' | 'preview' = 'write';
    private onMqChange: (e: MediaQueryListEvent) => void;
    private lastDirty = false;
    private draftTimer: number | null = null;
    private dirtyBadge: HTMLElement | null = null;

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
        this.preview.setNoteId(this.note.id);
        this.preview.update(this.content);
        this.preview.setTypedLinks(extractTypedLinks(this.note.frontmatter));

        this.previewUnsubscribe = showPreviewStore.subscribe((show) => {
            this.showPreview = show;
            this.applyLayout();
        });

        this.onMqChange = (e: MediaQueryListEvent) => {
            this.viewMode = e.matches ? 'tab' : 'split';
            this.applyLayout();
        };
        this.mqMobile.addEventListener('change', this.onMqChange);

        this.maybeOfferDraftRestore();
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
        this.preview.setNoteId(this.note.id);
        this.preview.update(this.content);
        this.preview.setTypedLinks(extractTypedLinks(this.note.frontmatter));
    }

    public destroy(): void {
        if (this.draftTimer !== null) {
            window.clearTimeout(this.draftTimer);
            this.draftTimer = null;
        }
        this.previewUnsubscribe();
        this.mqMobile.removeEventListener('change', this.onMqChange);
        this.preview.destroy();
        this.toolbar.destroy();
        this.autocomplete?.destroy();
    }

    /**
     * Compare draft snapshot against the note as it arrived from the server.
     * A draft that matches the server has nothing to restore.
     */
    private maybeOfferDraftRestore(): void {
        const draft = readDraft(this.note.id);
        if (draft === null) return;

        const same = draft.title === this.initialTitle()
            && draft.tags === this.initialTags()
            && draft.content === this.note.content;

        if (same) {
            clearDraft(this.note.id);
            this.cb.onDirtyChange?.(false);
            return;
        }

        const ok = window.confirm(
            `Restore your unsaved draft of "${this.note.title}" from ${formatDraftAge(draft.savedAt)}?`
        );

        if (!ok) {
            clearDraft(this.note.id);
            this.cb.onDirtyChange?.(false);
            return;
        }

        this.title = draft.title;
        this.tagsInput = draft.tags;
        this.content = draft.content;
        this.titleInput.value = draft.title;
        this.tagsField.value = draft.tags;
        this.textarea.value = draft.content;
        this.preview.update(draft.content);
        this.notifyDirty();
    }

    private notifyDirty(): void {
        const dirty = this.isDirty;
        const flipped = dirty !== this.lastDirty;

        if (flipped) this.lastDirty = dirty;
        this.updateDirtyBadge(dirty);

        // Storage side-effects BEFORE the callback so a refreshDrafts()
        // triggered by the host sees the current state, not a phantom key
        // that we're about to remove.
        if (dirty) {
            this.scheduleDraftSave();
        } else {
            if (this.draftTimer !== null) {
                window.clearTimeout(this.draftTimer);
                this.draftTimer = null;
            }
            clearDraft(this.note.id);
        }

        if (flipped) this.cb.onDirtyChange?.(dirty);
    }

    private scheduleDraftSave(): void {
        if (this.draftTimer !== null) {
            window.clearTimeout(this.draftTimer);
        }

        this.draftTimer = window.setTimeout(() => {
            this.draftTimer = null;
            writeDraft(this.note.id, {
                title: this.title,
                tags: this.tagsInput,
                content: this.content,
                savedAt: Date.now()
            });
            // Fire again so the sidebar's draft-set gets the newly-written
            // key even if the dirty flag hasn't flipped in this window.
            this.cb.onDirtyChange?.(true);
        }, DRAFT_DEBOUNCE_MS);
    }

    private updateDirtyBadge(dirty: boolean): void {
        if (this.dirtyBadge === null) return;
        this.dirtyBadge.style.visibility = dirty ? 'visible' : 'hidden';
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
            on: {input: (e) => {
                this.title = (e.target as HTMLInputElement).value;
                this.notifyDirty();
            }}
        }) as HTMLInputElement;

        this.tagsField = el('input', {
            attrs: {type: 'text', value: this.tagsInput},
            on: {input: (e) => {
                this.tagsInput = (e.target as HTMLInputElement).value;
                this.notifyDirty();
            }}
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
                    this.notifyDirty();
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
                this.notifyDirty();
            }
        });

        this.editorPane = el('div', {class: 'editor-pane'}, this.toolbar.element, this.textarea);

        if (this.cb.searchTitles !== undefined) {
            const search = this.cb.searchTitles;
            this.autocomplete = new WikilinkAutocomplete({
                textarea: this.textarea,
                host: this.editorPane,
                searchTitles: (q) => search(q),
                onChange: (value) => {
                    this.content = value;
                    this.preview.update(value);
                }
            });
        }

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

        this.dirtyBadge = el('span', {
            class: 'editor-dirty-badge',
            attrs: {title: 'Unsaved changes — auto-saved as draft in this browser', 'aria-label': 'Unsaved changes'},
            style: {visibility: 'hidden'},
            text: '● unsaved'
        });

        this.actionsHost = el('div', {class: 'editor-actions'}, this.dirtyBadge, saveBtn, cancelBtn, previewToggle);

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
            clearDraft(this.note.id);
            this.lastDirty = false;
            this.updateDirtyBadge(false);
            this.cb.onDirtyChange?.(false);
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

        this.notifyDirty();
        const cursor = start + insertion.length;
        this.textarea.selectionStart = cursor;
        this.textarea.selectionEnd = cursor;
        this.textarea.focus();
    }
}