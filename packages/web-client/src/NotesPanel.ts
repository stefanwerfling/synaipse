import type {Note} from '@synaipse/core';
import {extractTypedLinks} from '@synaipse/core';
import {api, NoteSummary} from './Api.js';
import {clear, el} from './Dom.js';
import {confirmDialog} from './Dialogs.js';
import type {Editor} from './Editor.js';
import {HistoryPanel} from './HistoryPanel.js';
import {LocalGraphPanel} from './LocalGraphPanel.js';
import {clipSnippet} from './HoverCard.js';
import {MarkdownPreview, NoteSnippet} from './MarkdownPreview.js';
import {renderBacklinks, renderOutgoing, type NoteLinkActions} from './NoteLinks.js';
import {NotesSidebar} from './NotesSidebar.js';
import {buildNoteHead, OverflowMenu} from './NoteToolbar.js';
import {NoteToc} from './NoteToc.js';
import {folderOfNoteId} from './NotesTree.js';
import {exportNoteToPdf} from './PdfExport.js';
import {SelectionAsk} from './SelectionAsk.js';
import {openSummarizeDialog} from './SummarizeDialog.js';
import {toastError} from './Toast.js';
import {buildWikilinkResolver, WikilinkResolver} from './Wikilinks.js';
import {fuzzyMatch} from './Fuzzy.js';
import type {WikilinkMatch} from './WikilinkAutocomplete.js';
import {defineMessages, tc} from './I18n.js';

const t = defineMessages('notesPanel', {
    unsavedTitle: 'Unsaved changes',
    discard: 'Discard',
    discardSwitch: 'Discard your changes and switch to the other note?',
    discardNew: 'Discard your changes and create a new note?',
    deleteTitle: 'Delete note?',
    deleteMessage: '{id} will be deleted.',
    deleteFailed: 'Could not delete',
    empty: '(empty)',
    noneTitle: 'No note selected',
    noneHint: 'Pick a note from the sidebar or create a new one to get started.'
});

export interface NotesPanelOptions {
    onNotesChanged: () => void;
    onAskAboutSelection?: (noteId: string, selection: string) => void;
    /** The open note changed (or none is open): the app keeps the URL in step. */
    onActiveNoteChange?: (noteId: string | null) => void;
}

const DEFAULT_CREATE_FOLDER = 'Memory/scratch';
/** Where a note created from an unresolved wikilink lands when no note is open (or it sits in the root). */
const WIKILINK_CREATE_FOLDER = 'Memory/research';

/**
 * The Notes tab (plan P7 / D2): coordinates the sidebar, the viewer
 * (head, preview, links, outline) and the editor around one open note.
 * The parts live in NotesSidebar, NoteToolbar, NoteLinks, NoteToc,
 * SelectionAsk and SummarizeDialog.
 */
export class NotesPanel {
    public readonly element: HTMLElement;
    private notes: NoteSummary[] = [];
    private activeId: string | null = null;
    private active: Note | null = null;
    private editing = false;
    private resolver: WikilinkResolver = () => undefined;
    private readonly snippetCache = new Map<string, NoteSnippet>();

    private readonly sidebar: NotesSidebar;
    private readonly viewer: HTMLElement;
    private readonly toc: NoteToc;
    private readonly localGraph: LocalGraphPanel;
    private readonly overflow = new OverflowMenu();
    private readonly selectionAsk: SelectionAsk | null;

    private viewerPreview: MarkdownPreview | null = null;
    private currentEditor: Editor | null = null;
    /** Bumped on every editor (re)build; a stale lazy load sees a newer value and gives up. */
    private editorGeneration = 0;
    private historyPanel: HistoryPanel | null = null;
    private historyEnabled = false;
    private chatEnabled = false;

    private readonly linkActions: NoteLinkActions = {
        open: (noteId) => void this.openNoteFromWikilink(noteId),
        create: (title) => this.createFromWikilink(title)
    };

    public constructor(private readonly opts: NotesPanelOptions) {
        this.element = el('div', {class: 'app'});

        this.sidebar = new NotesSidebar({
            layoutRoot: this.element,
            onSelect: (id) => void this.handleSelect(id),
            onNew: () => void this.handleNew(),
            onNewInFolder: (folder) => void this.handleNew(folder),
            onCreate: (path, title) => this.createNote(path, title)
        });

        this.localGraph = new LocalGraphPanel((id) => void this.handleSelect(id));
        this.viewer = el('main', {class: 'viewer'});
        this.toc = new NoteToc(this.element, this.viewer);

        const onAsk = opts.onAskAboutSelection;
        this.selectionAsk = onAsk === undefined ? null : new SelectionAsk({
            host: () => this.viewerPreview?.element ?? null,
            noteId: () => this.activeId,
            onAsk
        });

        this.element.appendChild(this.sidebar.element);
        this.element.appendChild(this.viewer);
        this.renderEmpty();
    }

    public setHistoryEnabled(enabled: boolean): void {
        if (this.historyEnabled === enabled) return;
        this.historyEnabled = enabled;
        this.renderViewer();
    }

    public setChatEnabled(enabled: boolean): void {
        if (this.chatEnabled === enabled) return;
        this.chatEnabled = enabled;
        this.renderViewer();
    }

    public setNotes(notes: NoteSummary[]): void {
        this.notes = notes;
        this.resolver = buildWikilinkResolver(notes);
        this.snippetCache.clear();
        this.sidebar.setNotes(notes);
        // The note set changed (SSE / write): links around the open note may have too.
        this.localGraph.refresh();
    }

    /** Resolves once the note is shown, or the user kept unsaved changes. */
    public openNote(id: string): Promise<void> {
        return this.handleSelect(id);
    }

    /** The id of the note in the viewer, null when none is open. */
    public activeNoteId(): string | null {
        return this.activeId;
    }

    /** Starts a new note (asks first when the editor has unsaved changes). */
    public newNote(): Promise<void> {
        return this.handleNew();
    }

    public destroy(): void {
        this.selectionAsk?.destroy();
        this.disposeViewer();
        this.disposeEditor();
        this.toc.destroy();
        this.localGraph.destroy();
        this.overflow.close();
        this.sidebar.destroy();
    }

    // --- navigation --------------------------------------------------------

    private setActiveId(id: string | null): void {
        this.sidebar.setActiveId(id);
        if (this.activeId === id) return;
        this.activeId = id;
        this.opts.onActiveNoteChange?.(id);
    }

    private async confirmDiscardIfDirty(promptMessage: string): Promise<boolean> {
        if (!this.editing || this.currentEditor === null || !this.currentEditor.isDirty) {
            return true;
        }

        return await confirmDialog({
            title: t('unsavedTitle'),
            message: promptMessage,
            confirmLabel: t('discard'),
            danger: true
        });
    }

    private async handleSelect(id: string, opts: {skipDirtyCheck?: boolean} = {}): Promise<void> {
        if (id === this.activeId && !this.editing) {
            return;
        }

        if (!opts.skipDirtyCheck && !await this.confirmDiscardIfDirty(t('discardSwitch'))) {
            return;
        }

        this.setActiveId(id);
        this.editing = false;
        this.sidebar.render();
        this.renderLoading();

        try {
            this.active = await api.getNote(id);
            this.renderViewer();
        } catch (e) {
            this.renderError(e);
        }
    }

    private openNoteFromWikilink = async (noteId: string): Promise<void> => {
        // Editor already prompted before calling here, skip the duplicate guard.
        await this.handleSelect(noteId, {skipDirtyCheck: true});
    };

    // --- create / delete / save -------------------------------------------

    /**
     * "+ New" (no folder: the open note's folder, else the fallback) or
     * "+" on a folder header. Opens the sidebar's create row.
     */
    private async handleNew(folder?: string): Promise<void> {
        if (!await this.confirmDiscardIfDirty(t('discardNew'))) {
            return;
        }
        this.sidebar.openCreateRow({folder: folder ?? this.defaultCreateFolder()});
    }

    /**
     * Default folder for a new note: the open note's folder when one
     * exists, else the fixed fallback. Keeps "+ New" context-aware.
     */
    private defaultCreateFolder(): string {
        if (this.active !== null) {
            const folder = folderOfNoteId(this.active.id);
            if (folder !== null && folder.length > 0) return folder;
        }
        return DEFAULT_CREATE_FOLDER;
    }

    /** Wikilink `[[X]]` for a missing note: seed the create row with X as slug and title, in the open note's folder. */
    private createFromWikilink(title: string): void {
        const folder = this.active !== null
            ? folderOfNoteId(this.active.id) ?? WIKILINK_CREATE_FOLDER
            : WIKILINK_CREATE_FOLDER;
        this.sidebar.openCreateRow({folder, title});
    }

    private async createNote(path: string, title: string): Promise<void> {
        const note = await api.writeNote({path, content: '', frontmatter: {title}});
        this.opts.onNotesChanged();
        this.setActiveId(note.id);
        this.active = note;
        this.editing = true;
        this.renderEditor();
    }

    private async handleDelete(): Promise<void> {
        if (this.active === null) {
            return;
        }

        const id = this.active.id;
        const ok = await confirmDialog({
            title: t('deleteTitle'),
            message: t('deleteMessage', {id}),
            confirmLabel: tc('delete'),
            danger: true
        });
        if (!ok || this.active?.id !== id) {
            return;
        }

        try {
            await api.deleteNote(id);
            this.active = null;
            this.setActiveId(null);
            this.editing = false;
            this.opts.onNotesChanged();
            this.renderEmpty();
        } catch (e) {
            toastError(t('deleteFailed'), e);
        }
    }

    private async handleSave(input: {content: string; frontmatter: Note['frontmatter']}): Promise<void> {
        if (this.active === null) {
            return;
        }

        const saved = await api.writeNote({
            path: this.active.id,
            content: input.content,
            frontmatter: input.frontmatter
        });

        this.active = saved;
        this.editing = false;
        this.opts.onNotesChanged();
        this.renderViewer();
    }

    // --- viewer ------------------------------------------------------------

    private fetchSnippet = async (noteId: string): Promise<NoteSnippet> => {
        const cached = this.snippetCache.get(noteId);

        if (cached) {
            return cached;
        }

        const note = await api.getNote(noteId);
        const snippet: NoteSnippet = {
            title: note.title,
            tags: note.tags,
            preview: clipSnippet(note.content, 220) || t('empty')
        };
        this.snippetCache.set(noteId, snippet);
        return snippet;
    };

    private searchTitles(query: string): readonly WikilinkMatch[] {
        if (query.length === 0) {
            return this.notes
                .filter((n) => n.title.length > 0)
                .slice(0, 8)
                .map((n) => ({noteId: n.id, title: n.title}));
        }

        const scored: Array<{noteId: string; title: string; score: number}> = [];
        for (const n of this.notes) {
            if (n.title.length === 0) continue;
            const r = fuzzyMatch(query, n.title);
            if (r.matched) {
                scored.push({noteId: n.id, title: n.title, score: r.score});
            }
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, 8);
    }

    /** Clear the viewer for a new state; the outline follows the (possibly gone) preview. */
    private resetViewer(): void {
        this.overflow.close();
        clear(this.viewer);
    }

    private renderEmpty(): void {
        this.disposeViewer();
        this.disposeEditor();
        this.resetViewer();
        this.toc.update(null);

        this.viewer.appendChild(el('div', {class: 'viewer-empty'},
            el('div', {class: 'viewer-empty-icon', text: '◌'}),
            el('h2', {class: 'viewer-empty-title', text: t('noneTitle')}),
            el('p', {class: 'viewer-empty-hint', text: t('noneHint')})
        ));
    }

    private renderLoading(): void {
        this.resetViewer();
        this.toc.update(this.viewerPreview?.element ?? null);
        this.viewer.appendChild(el('p', {class: 'loading', text: tc('loading')}));
    }

    private renderError(error: unknown): void {
        this.resetViewer();
        this.toc.update(this.viewerPreview?.element ?? null);
        const message = error instanceof Error ? error.message : String(error);
        this.viewer.appendChild(el('p', {class: 'editor-error', text: message}));
    }

    private renderViewer(): void {
        if (this.active === null) {
            this.renderEmpty();
            return;
        }

        const note = this.active;
        this.disposeEditor();
        clear(this.viewer);

        for (const part of buildNoteHead(note, {
            ...(this.chatEnabled ? {onSummarize: () => void openSummarizeDialog(note, () => this.opts.onNotesChanged())} : {}),
            ...(this.historyEnabled ? {onHistory: () => void this.toggleHistory()} : {}),
            onExportPdf: () => void this.exportPdf(),
            onEdit: () => this.startEditing(),
            onDelete: () => void this.handleDelete()
        }, this.overflow)) {
            this.viewer.appendChild(part);
        }

        if (this.viewerPreview === null) {
            this.viewerPreview = new MarkdownPreview({
                resolveWikilink: this.resolver,
                onWikilinkClick: (noteId) => void this.openNoteFromWikilink(noteId),
                onUnresolvedClick: (title) => this.createFromWikilink(title),
                fetchSnippet: this.fetchSnippet
            });
        }

        this.viewer.appendChild(this.viewerPreview.element);
        this.viewerPreview.setNoteId(note.id);
        this.viewerPreview.update(note.content);
        this.viewerPreview.setTypedLinks(extractTypedLinks(note.frontmatter));
        this.renderLinks(note);
        if (this.chatEnabled) this.selectionAsk?.attach();
        this.toc.update(this.viewerPreview.element);
    }

    /** Local graph, "Linked from" and "Links to" below the preview; nothing when the note has no links at all. */
    private renderLinks(note: Note): void {
        const backlinks = note.backlinks;
        const outgoing = note.wikilinks;

        if (backlinks.length === 0 && outgoing.length === 0 && extractTypedLinks(note.frontmatter).length === 0) {
            this.localGraph.element.remove();
            this.localGraph.setNote(null);
            return;
        }

        const section = el('section', {class: 'viewer-links'});

        section.appendChild(this.localGraph.element);
        this.localGraph.setNote(note.id);

        if (backlinks.length > 0) {
            section.appendChild(renderBacklinks(backlinks, new Map(this.notes.map((n) => [n.id, n])), this.linkActions));
        }

        if (outgoing.length > 0) {
            section.appendChild(renderOutgoing(outgoing, this.resolver, this.linkActions));
        }

        this.viewer.appendChild(section);
    }

    private async toggleHistory(): Promise<void> {
        if (this.historyPanel !== null) {
            this.closeHistory();
            return;
        }

        if (this.activeId === null) return;

        this.historyPanel = new HistoryPanel({onClose: () => this.closeHistory()});
        this.viewer.appendChild(this.historyPanel.element);
        await this.historyPanel.load(this.activeId);
    }

    private closeHistory(): void {
        if (this.historyPanel === null) return;
        this.historyPanel.element.remove();
        this.historyPanel = null;
    }

    private async exportPdf(): Promise<void> {
        if (this.active === null) return;
        try {
            await exportNoteToPdf({
                id: this.active.id,
                title: this.active.title,
                content: this.active.content,
                tags: this.active.tags
            });
        } catch (e) {
            console.error('PDF export failed', e);
        }
    }

    // --- editor ------------------------------------------------------------

    /** The editor is its own chunk (plan P7 / S4b): most visits only read. */
    private renderEditor(): void {
        if (this.active === null) {
            this.renderEmpty();
            return;
        }

        this.disposeViewer();
        this.disposeEditor();
        clear(this.viewer);

        const generation = ++this.editorGeneration;
        const note = this.active;
        const loading = el('p', {class: 'loading', text: tc('loading')});
        this.viewer.appendChild(loading);

        void import('./Editor.js').then(({Editor}) => {
            // Another note, viewer or editor took over while the chunk loaded.
            if (generation !== this.editorGeneration || !this.editing || this.active !== note) return;
            loading.remove();
            this.mountEditor(new Editor(note, this.editorCallbacks()));
        }, (cause: unknown) => {
            if (generation !== this.editorGeneration) return;
            loading.remove();
            this.viewer.appendChild(el('p', {class: 'editor-error', text: String(cause)}));
        });
    }

    private editorCallbacks(): ConstructorParameters<typeof Editor>[1] {
        return {
            onSave: (input) => this.handleSave(input),
            onCancel: () => {
                this.editing = false;
                this.renderViewer();
            },
            resolveWikilink: this.resolver,
            onWikilinkClick: (noteId) => void this.openNoteFromWikilink(noteId),
            onUnresolvedClick: (title) => this.createFromWikilink(title),
            fetchSnippet: this.fetchSnippet,
            searchTitles: (query) => this.searchTitles(query),
            onDirtyChange: () => this.sidebar.refreshDrafts()
        };
    }

    private mountEditor(editor: Editor): void {
        this.currentEditor = editor;
        this.viewer.appendChild(editor.element);
        this.toc.update(null);
    }

    private startEditing(): void {
        if (this.active === null) {
            return;
        }

        this.editing = true;
        this.renderEditor();
    }

    private disposeViewer(): void {
        if (this.viewerPreview !== null) {
            this.viewerPreview.destroy();
            this.viewerPreview = null;
        }
    }

    private disposeEditor(): void {
        // Also cancels an editor chunk that is still loading.
        this.editorGeneration += 1;
        if (this.currentEditor !== null) {
            this.currentEditor.destroy();
            this.currentEditor = null;
        }
    }
}
