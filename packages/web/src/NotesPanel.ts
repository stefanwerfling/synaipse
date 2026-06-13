import type {Note} from '@synaipse/core';
import {api, NoteSummary} from './Api.js';
import {tagColor} from './Colors.js';
import {clear, el} from './Dom.js';
import {Editor} from './Editor.js';
import {HistoryPanel} from './HistoryPanel.js';
import {clipSnippet} from './HoverCard.js';
import {MarkdownPreview, NoteSnippet} from './MarkdownPreview.js';
import {PersistentValue, setCodec} from './Persistence.js';
import {buildWikilinkResolver, slugify, WikilinkResolver} from './Wikilinks.js';

export interface NotesPanelOptions {
    onNotesChanged: () => void;
}

type GroupMode = 'folder' | 'tag' | 'recent';

const STORAGE_GROUP_MODE = 'synaipse.notes.groupMode';
const STORAGE_COLLAPSED = 'synaipse.notes.collapsedGroups';

const RECENT_BUCKETS = ['Today', 'Yesterday', 'This week', 'This month', 'Earlier'] as const;
const UNTAGGED_LABEL = 'untagged';
const ROOT_FOLDER_LABEL = '/';

interface NoteGroup {
    key: string;
    label: string;
    notes: NoteSummary[];
}

const startOfDay = (ts: number): number => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
};

const recencyBucket = (mtime: number, now: number): typeof RECENT_BUCKETS[number] => {
    const today = startOfDay(now);
    const day = 86_400_000;

    if (mtime >= today) return 'Today';
    if (mtime >= today - day) return 'Yesterday';
    if (mtime >= today - day * 7) return 'This week';
    if (mtime >= today - day * 30) return 'This month';
    return 'Earlier';
};

const folderOf = (id: string): string => {
    const slash = id.lastIndexOf('/');
    return slash === -1 ? ROOT_FOLDER_LABEL : id.slice(0, slash);
};

const buildGroups = (notes: NoteSummary[], mode: GroupMode, now: number): NoteGroup[] => {
    const map = new Map<string, NoteGroup>();

    const ensure = (key: string, label: string): NoteGroup => {
        let group = map.get(key);

        if (group === undefined) {
            group = {key, label, notes: []};
            map.set(key, group);
        }

        return group;
    };

    if (mode === 'folder') {
        for (const note of notes) {
            const folder = folderOf(note.id);
            ensure(folder, folder).notes.push(note);
        }

        return [...map.values()].sort((a, b) => {
            if (a.label === ROOT_FOLDER_LABEL) return 1;
            if (b.label === ROOT_FOLDER_LABEL) return -1;
            return a.label.localeCompare(b.label);
        });
    }

    if (mode === 'tag') {
        for (const note of notes) {
            const primary = note.tags[0] ?? UNTAGGED_LABEL;
            ensure(primary, primary).notes.push(note);
        }

        return [...map.values()].sort((a, b) => {
            if (a.label === UNTAGGED_LABEL) return 1;
            if (b.label === UNTAGGED_LABEL) return -1;
            return b.notes.length - a.notes.length || a.label.localeCompare(b.label);
        });
    }

    for (const bucket of RECENT_BUCKETS) {
        ensure(bucket, bucket);
    }

    for (const note of notes) {
        const bucket = recencyBucket(note.mtime, now);
        ensure(bucket, bucket).notes.push(note);
    }

    const order = new Map(RECENT_BUCKETS.map((b, i) => [b, i]));

    return [...map.values()]
        .filter((g) => g.notes.length > 0)
        .sort((a, b) => (order.get(a.label as typeof RECENT_BUCKETS[number]) ?? 0) - (order.get(b.label as typeof RECENT_BUCKETS[number]) ?? 0));
};

const promptForPath = (): string | null => {
    const raw = window.prompt('Note path (relative to vault, e.g. Memory/decisions/2026-06-11-foo.md)');

    if (raw === null) {
        return null;
    }

    const trimmed = raw.trim();

    if (trimmed.length === 0) {
        return null;
    }

    return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
};

export class NotesPanel {
    public readonly element: HTMLElement;
    private notes: NoteSummary[] = [];
    private activeId: string | null = null;
    private active: Note | null = null;
    private editing = false;
    private filter = '';
    private resolver: WikilinkResolver = () => undefined;
    private readonly snippetCache = new Map<string, NoteSnippet>();

    private sidebar!: HTMLElement;
    private viewer!: HTMLElement;
    private filterInput!: HTMLInputElement;
    private noteList!: HTMLUListElement;
    private noteCounter!: HTMLElement;
    private modeSwitcher!: HTMLElement;

    private readonly groupMode = new PersistentValue<GroupMode>(STORAGE_GROUP_MODE, 'folder');
    private readonly collapsedGroups = new PersistentValue<ReadonlySet<string>>(STORAGE_COLLAPSED, new Set(), setCodec);
    private unsubscribeGroupMode: () => void = () => {};
    private unsubscribeCollapsed: () => void = () => {};

    private viewerPreview: MarkdownPreview | null = null;
    private currentEditor: Editor | null = null;
    private historyPanel: HistoryPanel | null = null;
    private historyEnabled = false;

    public setHistoryEnabled(enabled: boolean): void {
        if (this.historyEnabled === enabled) return;
        this.historyEnabled = enabled;
        this.renderViewer();
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

    public constructor(private readonly opts: NotesPanelOptions) {
        this.element = el('div', {class: 'app'});
        this.build();

        this.unsubscribeGroupMode = this.groupMode.subscribe(() => {
            this.renderModeSwitcher();
            this.renderNoteList();
        });

        this.unsubscribeCollapsed = this.collapsedGroups.subscribe(() => {
            this.renderNoteList();
        });
    }

    public setNotes(notes: NoteSummary[]): void {
        this.notes = notes;
        this.resolver = buildWikilinkResolver(notes);
        this.snippetCache.clear();
        this.renderNoteList();
    }

    public destroy(): void {
        this.disposeViewer();
        this.disposeEditor();
        this.unsubscribeGroupMode();
        this.unsubscribeCollapsed();
    }

    private build(): void {
        this.filterInput = el('input', {
            attrs: {type: 'text', placeholder: 'Filter notes…'},
            on: {input: (e) => {
                this.filter = (e.target as HTMLInputElement).value;
                this.renderNoteList();
            }}
        }) as HTMLInputElement;

        const newBtn = el('button', {
            class: 'btn btn-primary btn-new',
            attrs: {type: 'button', title: 'New note'},
            text: '+ New',
            on: {click: () => void this.handleNew()}
        });

        const head = el('div', {class: 'sidebar-head'}, this.filterInput, newBtn);

        this.modeSwitcher = el('div', {class: 'group-mode-switcher', attrs: {role: 'group', 'aria-label': 'Group notes by'}});
        this.renderModeSwitcher();

        this.noteCounter = el('div', {class: 'sidebar-counter', text: '0 notes'});

        this.noteList = el('ul', {class: 'note-list'}) as HTMLUListElement;

        this.sidebar = el('aside', {class: 'sidebar'}, head, this.modeSwitcher, this.noteCounter, this.noteList);

        this.viewer = el('main', {class: 'viewer'});
        this.renderEmpty();

        this.element.appendChild(this.sidebar);
        this.element.appendChild(this.viewer);
    }

    private renderModeSwitcher(): void {
        clear(this.modeSwitcher);
        const current = this.groupMode.get();

        const button = (mode: GroupMode, label: string, title: string): HTMLElement => el('button', {
            class: mode === current ? 'group-mode-btn active' : 'group-mode-btn',
            attrs: {type: 'button', title, 'aria-pressed': mode === current ? 'true' : 'false'},
            text: label,
            on: {click: () => {
                if (mode !== this.groupMode.get()) {
                    this.groupMode.set(mode);
                }
            }}
        });

        this.modeSwitcher.appendChild(button('folder', 'folder', 'Group by folder'));
        this.modeSwitcher.appendChild(button('tag', 'tag', 'Group by primary tag'));
        this.modeSwitcher.appendChild(button('recent', 'recent', 'Group by modification time'));
    }

    private renderNoteList(): void {
        const q = this.filter.trim().toLowerCase();
        const visible = q === ''
            ? this.notes
            : this.notes.filter((n) => n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q));

        clear(this.noteList);

        const total = this.notes.length;

        if (q === '') {
            this.noteCounter.textContent = total === 1 ? '1 note' : `${total} notes`;
        } else {
            this.noteCounter.textContent = `${visible.length} of ${total}`;
        }

        if (this.notes.length === 0) {
            this.noteList.appendChild(el('li', {class: 'note-list-empty'},
                el('div', {class: 'note-list-empty-title', text: 'No notes yet'}),
                el('div', {class: 'note-list-empty-hint', text: 'Click + New to create your first note.'})
            ));
            return;
        }

        if (visible.length === 0) {
            this.noteList.appendChild(el('li', {class: 'note-list-empty'},
                el('div', {class: 'note-list-empty-title', text: 'No matches'}),
                el('div', {class: 'note-list-empty-hint', text: `No notes match "${this.filter}".`})
            ));
            return;
        }

        const mode = this.groupMode.get();
        const collapsed = this.collapsedGroups.get();
        const groups = buildGroups(visible, mode, Date.now());

        for (const group of groups) {
            const groupKey = `${mode}:${group.key}`;
            const isCollapsed = collapsed.has(groupKey);

            const header = el('li', {
                class: isCollapsed ? 'note-group-header collapsed' : 'note-group-header',
                attrs: {role: 'button', tabindex: '0'},
                on: {click: () => this.toggleGroup(groupKey)}
            },
                el('span', {class: 'note-group-caret', text: '▾'}),
                el('span', {class: 'note-group-label', text: group.label}),
                el('span', {class: 'note-group-count', text: String(group.notes.length)})
            );

            this.noteList.appendChild(header);

            if (isCollapsed) {
                continue;
            }

            for (const n of group.notes) {
                const meta = el('div', {class: 'note-list-meta'},
                    el('span', {class: 'note-list-path', text: n.id})
                );

                if (n.tags.length > 0) {
                    const chipHost = el('div', {class: 'note-list-tags'});

                    for (const tag of n.tags.slice(0, 3)) {
                        const color = tagColor(tag);
                        chipHost.appendChild(el('span', {
                            class: 'note-list-tag',
                            text: tag,
                            style: {borderColor: color, color}
                        }));
                    }

                    if (n.tags.length > 3) {
                        chipHost.appendChild(el('span', {class: 'note-list-tag-more', text: `+${n.tags.length - 3}`}));
                    }

                    meta.appendChild(chipHost);
                }

                const li = el('li', {
                    class: n.id === this.activeId ? 'note-list-item active' : 'note-list-item',
                    on: {click: () => this.handleSelect(n.id)}
                },
                    el('div', {class: 'note-list-title', text: n.title}),
                    meta
                );

                this.noteList.appendChild(li);
            }
        }
    }

    private toggleGroup(groupKey: string): void {
        this.collapsedGroups.update((prev) => {
            const next = new Set(prev);

            if (next.has(groupKey)) {
                next.delete(groupKey);
            } else {
                next.add(groupKey);
            }

            return next;
        });
    }

    public openNote(id: string): void {
        void this.handleSelect(id);
    }

    private confirmDiscardIfDirty(promptMessage: string): boolean {
        if (!this.editing || this.currentEditor === null || !this.currentEditor.isDirty) {
            return true;
        }

        return window.confirm(promptMessage);
    }

    private async handleSelect(id: string, opts: {skipDirtyCheck?: boolean} = {}): Promise<void> {
        if (id === this.activeId && !this.editing) {
            return;
        }

        if (!opts.skipDirtyCheck && !this.confirmDiscardIfDirty('You have unsaved changes. Discard and switch note?')) {
            return;
        }

        this.activeId = id;
        this.editing = false;
        this.renderNoteList();
        this.renderLoading();

        try {
            this.active = await api.getNote(id);
            this.renderViewer();
        } catch (e) {
            this.renderError(e);
        }
    }

    private async handleNew(): Promise<void> {
        if (!this.confirmDiscardIfDirty('You have unsaved changes. Discard and create a new note?')) {
            return;
        }

        const path = promptForPath();

        if (path === null) {
            return;
        }

        try {
            const note = await api.writeNote({path, content: '', frontmatter: {title: path}});
            this.opts.onNotesChanged();
            this.activeId = note.id;
            this.active = note;
            this.editing = true;
            this.renderEditor();
        } catch (e) {
            window.alert(`Could not create note: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private async handleDelete(): Promise<void> {
        if (this.active === null) {
            return;
        }

        if (!window.confirm(`Delete ${this.active.id}?`)) {
            return;
        }

        try {
            await api.deleteNote(this.active.id);
            this.active = null;
            this.activeId = null;
            this.editing = false;
            this.opts.onNotesChanged();
            this.renderEmpty();
        } catch (e) {
            window.alert(`Could not delete: ${e instanceof Error ? e.message : String(e)}`);
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

    private openNoteFromWikilink = async (noteId: string): Promise<void> => {
        // Editor already prompted before calling here, skip the duplicate guard.
        await this.handleSelect(noteId, {skipDirtyCheck: true});
    };

    private createFromWikilink = async (title: string): Promise<void> => {
        const slug = slugify(title);
        const suggestion = `Memory/research/${slug || 'untitled'}.md`;
        const raw = window.prompt(`Create note "${title}" at:`, suggestion);

        if (raw === null) {
            return;
        }

        const trimmed = raw.trim();

        if (trimmed.length === 0) {
            return;
        }

        const path = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;

        try {
            const note = await api.writeNote({path, content: '', frontmatter: {title}});
            this.opts.onNotesChanged();
            this.activeId = note.id;
            this.active = note;
            this.editing = true;
            this.renderEditor();
        } catch (e) {
            window.alert(`Could not create note: ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    private fetchSnippet = async (noteId: string): Promise<NoteSnippet> => {
        const cached = this.snippetCache.get(noteId);

        if (cached) {
            return cached;
        }

        const note = await api.getNote(noteId);
        const snippet: NoteSnippet = {
            title: note.title,
            tags: note.tags,
            preview: clipSnippet(note.content, 220) || '(empty)'
        };
        this.snippetCache.set(noteId, snippet);
        return snippet;
    };

    private renderEmpty(): void {
        this.disposeViewer();
        this.disposeEditor();
        clear(this.viewer);

        const empty = el('div', {class: 'viewer-empty'},
            el('div', {class: 'viewer-empty-icon', text: '◌'}),
            el('h2', {class: 'viewer-empty-title', text: 'No note selected'}),
            el('p', {class: 'viewer-empty-hint', text: 'Pick a note from the sidebar or create a new one to get started.'})
        );

        this.viewer.appendChild(empty);
    }

    private renderLoading(): void {
        clear(this.viewer);
        this.viewer.appendChild(el('p', {class: 'loading', text: 'loading…'}));
    }

    private renderError(error: unknown): void {
        clear(this.viewer);
        const message = error instanceof Error ? error.message : String(error);
        this.viewer.appendChild(el('p', {class: 'editor-error', text: message}));
    }

    private renderViewer(): void {
        if (this.active === null) {
            this.renderEmpty();
            return;
        }

        this.disposeEditor();
        clear(this.viewer);

        const actions: HTMLElement[] = [];

        if (this.historyEnabled) {
            actions.push(el('button', {
                class: 'btn',
                attrs: {type: 'button', title: 'Show change history'},
                text: 'History',
                on: {click: () => void this.toggleHistory()}
            }));
        }

        actions.push(
            el('button', {
                class: 'btn',
                attrs: {type: 'button'},
                text: 'Edit',
                on: {click: () => this.startEditing()}
            }),
            el('button', {
                class: 'btn btn-danger',
                attrs: {type: 'button'},
                text: 'Delete',
                on: {click: () => void this.handleDelete()}
            })
        );

        const head = el('div', {class: 'viewer-head'},
            el('h1', {text: this.active.title}),
            el('div', {class: 'viewer-actions'}, ...actions)
        );

        this.viewer.appendChild(head);

        if (this.active.tags.length > 0) {
            const tagHost = el('div', {class: 'viewer-tags'});

            for (const tag of this.active.tags) {
                const color = tagColor(tag);
                tagHost.appendChild(el('span', {
                    class: 'viewer-tag',
                    style: {borderColor: color, color}
                },
                    el('span', {class: 'viewer-tag-swatch', style: {background: color}}),
                    el('span', {class: 'viewer-tag-label', text: tag})
                ));
            }

            this.viewer.appendChild(tagHost);
        }

        if (this.viewerPreview === null) {
            this.viewerPreview = new MarkdownPreview({
                resolveWikilink: this.resolver,
                onWikilinkClick: (noteId) => void this.openNoteFromWikilink(noteId),
                onUnresolvedClick: (title) => void this.createFromWikilink(title),
                fetchSnippet: this.fetchSnippet
            });
        }

        this.viewer.appendChild(this.viewerPreview.element);
        this.viewerPreview.update(this.active.content);
    }

    private renderEditor(): void {
        if (this.active === null) {
            this.renderEmpty();
            return;
        }

        this.disposeViewer();
        this.disposeEditor();
        clear(this.viewer);

        this.currentEditor = new Editor(this.active, {
            onSave: (input) => this.handleSave(input),
            onCancel: () => {
                this.editing = false;
                this.renderViewer();
            },
            resolveWikilink: this.resolver,
            onWikilinkClick: (noteId) => void this.openNoteFromWikilink(noteId),
            onUnresolvedClick: (title) => void this.createFromWikilink(title),
            fetchSnippet: this.fetchSnippet
        });

        this.viewer.appendChild(this.currentEditor.element);
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
        if (this.currentEditor !== null) {
            this.currentEditor.destroy();
            this.currentEditor = null;
        }
    }
}