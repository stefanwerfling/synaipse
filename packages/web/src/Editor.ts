import type {Frontmatter, Note} from '@synaipse/core';
import {clear, el} from './Dom.js';
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
    private previewHost!: HTMLElement;
    private actionsHost!: HTMLElement;
    private errorHost!: HTMLElement;
    private preview: MarkdownPreview;
    private previewUnsubscribe: () => void;

    public constructor(note: Note, private readonly cb: EditorCallbacks) {
        this.note = note;
        this.title = this.initialTitle();
        this.tagsInput = this.initialTags();
        this.content = note.content;
        this.showPreview = showPreviewStore.get();

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
            this.applyPreviewVisibility();
        });
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
        this.preview.destroy();
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
            on: {input: (e) => {
                this.content = (e.target as HTMLTextAreaElement).value;
                this.preview.update(this.content);
            }}
        }) as HTMLTextAreaElement;
        this.textarea.value = this.content;

        this.previewHost = this.preview.element;
        this.splitContainer = el('div',
            {class: this.showPreview ? 'editor-split' : 'editor-split single'},
            this.textarea,
            this.previewHost
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
        this.element.appendChild(this.splitContainer);
        this.element.appendChild(this.errorHost);
        this.element.appendChild(this.actionsHost);

        this.applyPreviewVisibility();
    }

    private applyPreviewVisibility(): void {
        this.splitContainer.className = this.showPreview ? 'editor-split' : 'editor-split single';
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
}