import type {NoteSummary} from './Api.js';
import {applyTagText, tagColor} from './Colors.js';
import {clear, el} from './Dom.js';
import {listDraftIds} from './Drafts.js';
import {GROUP_ROW_H, firstRowAt, layoutRows, noteRowHeight, type GroupMode, type VirtualRow} from './NotesTree.js';
import {PersistentValue, setCodec} from './Persistence.js';
import {slugify} from './Wikilinks.js';
import {defineMessages} from './I18n.js';

const t = defineMessages('notesSidebar', {
    filter: 'Filter notes…',
    newNote: 'New note',
    newShort: '+ New',
    groupBy: 'Group notes by',
    name: 'Name…',
    nameLabel: 'Note name',
    inFolder: 'in {folder}',
    error: 'Error: {message}',
    resize: 'Resize sidebar',
    resizeHint: 'Drag to resize, double-click to reset',
    modeFolder: 'folder',
    modeTag: 'tag',
    modeRecent: 'recent',
    byFolder: 'Group by folder',
    byTag: 'Group by primary tag',
    byRecent: 'Group by modification time',
    count: '{count} note|{count} notes',
    countFiltered: '{visible} of {total}',
    emptyTitle: 'No notes yet',
    emptyHint: 'Click + New to create your first note.',
    noMatchTitle: 'No matches',
    noMatchHint: 'No notes match “{filter}”.',
    newIn: 'New note in {folder}',
    toggleGroup: 'Expand or collapse {folder}',
    private: 'GDPR: private, never sent to external LLMs',
    draft: 'Unsaved draft'
});

const STORAGE_GROUP_MODE = 'synaipse.notes.groupMode';
const STORAGE_COLLAPSED = 'synaipse.notes.collapsedGroups';
const STORAGE_SIDEBAR_W = 'synaipse.notes.sidebarWidth';
const SIDEBAR_W_DEFAULT = 320;
const SIDEBAR_W_MIN = 220;
const SIDEBAR_W_MAX = 640;
const VIRT_BUFFER = 8;

export interface NotesSidebarOptions {
    /** Gets `--sidebar-w`, which its grid template consumes. */
    layoutRoot: HTMLElement;
    onSelect: (id: string) => void;
    /** "+ New" in the head. */
    onNew: () => void;
    /** "+" on a folder header. */
    onNewInFolder: (folder: string) => void;
    /** The inline create row was confirmed; a rejection shows its message in the row. */
    onCreate: (path: string, title: string) => Promise<void>;
}

/**
 * The notes sidebar (plan P7 / D2): filter, grouping switcher, inline
 * create row and the virtualised, grouped note list, plus the width
 * handle. Knows nothing about the open note beyond its id.
 */
export class NotesSidebar {
    public readonly element: HTMLElement;
    private notes: NoteSummary[] = [];
    private filter = '';
    private activeId: string | null = null;
    private draftIds: Set<string>;

    private readonly noteList: HTMLUListElement;
    private readonly noteCounter: HTMLElement;
    private readonly modeSwitcher: HTMLElement;
    private readonly createRow: HTMLElement;
    private readonly createInput: HTMLInputElement;
    private readonly createHint: HTMLElement;
    private createContext: {folder: string; title?: string} | null = null;

    private readonly groupMode = new PersistentValue<GroupMode>(STORAGE_GROUP_MODE, 'folder');
    private readonly collapsedGroups = new PersistentValue<ReadonlySet<string>>(STORAGE_COLLAPSED, new Set(), setCodec);
    // 250ms debounce is short enough to feel instant on the next reload but
    // slow enough that a drag doesn't hammer localStorage on every mousemove.
    private readonly sidebarWidth = new PersistentValue<number>(STORAGE_SIDEBAR_W, SIDEBAR_W_DEFAULT, undefined, 250);
    private readonly unsubscribeGroupMode: () => void;
    private readonly unsubscribeCollapsed: () => void;
    private detachResize: () => void = () => {};

    // virtualised list state
    private rows: VirtualRow[] = [];
    private rowOffsets: number[] = [];
    private virtualFrame: number | null = null;

    public constructor(private readonly opts: NotesSidebarOptions) {
        this.draftIds = listDraftIds();

        const filterInput = el('input', {
            attrs: {type: 'text', placeholder: t('filter')},
            on: {input: (e) => {
                this.filter = (e.target as HTMLInputElement).value;
                this.render();
            }}
        }) as HTMLInputElement;

        const newBtn = el('button', {
            class: 'btn btn-primary btn-new',
            attrs: {type: 'button', title: t('newNote')},
            text: t('newShort'),
            on: {click: () => this.opts.onNew()}
        });

        const head = el('div', {class: 'sidebar-head'}, filterInput, newBtn);

        this.modeSwitcher = el('div', {class: 'group-mode-switcher', attrs: {role: 'group', 'aria-label': t('groupBy')}});
        this.renderModeSwitcher();

        this.createInput = el('input', {
            class: 'create-row-input',
            attrs: {type: 'text', placeholder: t('name'), 'aria-label': t('nameLabel')},
            on: {keydown: (e) => this.onCreateInputKey(e as KeyboardEvent)}
        }) as HTMLInputElement;
        this.createHint = el('div', {class: 'create-row-hint'});
        this.createRow = el('div', {class: 'create-row', attrs: {hidden: 'hidden'}},
            this.createHint,
            this.createInput
        );

        this.noteCounter = el('div', {class: 'sidebar-counter', text: t('count', {count: 0})});

        this.noteList = el('ul', {
            class: 'note-list',
            on: {scroll: () => this.scheduleVirtualRender()}
        }) as HTMLUListElement;

        this.element = el('aside', {class: 'sidebar'}, head, this.modeSwitcher, this.createRow, this.noteCounter, this.noteList);
        this.installResizer();

        this.unsubscribeGroupMode = this.groupMode.subscribe(() => {
            this.renderModeSwitcher();
            this.render();
        });

        this.unsubscribeCollapsed = this.collapsedGroups.subscribe(() => {
            this.render();
        });
    }

    public setNotes(notes: NoteSummary[]): void {
        this.notes = notes;
        this.render();
    }

    /** Highlight `id`; takes effect on the next {@link render}. */
    public setActiveId(id: string | null): void {
        this.activeId = id;
    }

    public destroy(): void {
        if (this.virtualFrame !== null) {
            window.cancelAnimationFrame(this.virtualFrame);
            this.virtualFrame = null;
        }
        this.unsubscribeGroupMode();
        this.unsubscribeCollapsed();
        this.detachResize();
        this.sidebarWidth.destroy();
        this.groupMode.destroy();
        this.collapsedGroups.destroy();
    }

    // --- create row --------------------------------------------------------

    /** Show the inline "name the new note" row for `folder`, prefilled from `title` when given. */
    public openCreateRow(context: {folder: string; title?: string}): void {
        const folder = context.folder.replace(/\/+$/, '');
        this.createContext = context.title !== undefined
            ? {folder, title: context.title}
            : {folder};
        this.createHint.classList.remove('create-row-hint-error');
        this.createHint.textContent = t('inFolder', {folder: folder.length > 0 ? folder + '/' : '/'});
        this.createInput.value = context.title !== undefined ? slugify(context.title) : '';
        this.createRow.removeAttribute('hidden');
        // Focus + select once the row is in the layout (post-layout tick).
        window.requestAnimationFrame(() => {
            this.createInput.focus();
            this.createInput.select();
        });
    }

    private closeCreateRow(): void {
        this.createRow.setAttribute('hidden', 'hidden');
        this.createContext = null;
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
        if (this.createContext === null) return;

        const raw = this.createInput.value.trim();
        if (raw.length === 0) return;

        const nameOnly = raw.replace(/\.md$/i, '');
        const slug = slugify(nameOnly) || 'untitled';
        const folder = this.createContext.folder;
        const path = folder.length > 0 ? `${folder}/${slug}.md` : `${slug}.md`;
        const title = this.createContext.title ?? nameOnly;

        try {
            await this.opts.onCreate(path, title);
            this.closeCreateRow();
        } catch (e) {
            this.createHint.textContent = t('error', {message: e instanceof Error ? e.message : String(e)});
            this.createHint.classList.add('create-row-hint-error');
        }
    }

    // --- drafts ------------------------------------------------------------

    /**
     * Re-scan localStorage for draft keys. Called from the Editor's
     * dirty-change callback (fires on every edit and on save/discard),
     * cheap enough that we don't need to diff, and keeps the ● markers
     * accurate without a global bus.
     */
    public refreshDrafts(): void {
        const next = listDraftIds();
        const changed = next.size !== this.draftIds.size
            || [...next].some((id) => !this.draftIds.has(id));

        if (!changed) return;

        this.draftIds = next;
        this.render();
    }

    // --- width handle ------------------------------------------------------

    /**
     * Draggable resizer at the sidebar's right border. Width is driven by
     * `--sidebar-w` on the layout root; a debounced PersistentValue writes
     * to localStorage so a live drag doesn't hammer disk. Clamped between
     * MIN and MAX. Double-click resets to the default width.
     */
    private installResizer(): void {
        const clamp = (w: number): number => Math.max(SIDEBAR_W_MIN, Math.min(SIDEBAR_W_MAX, w));

        const applyWidth = (w: number): void => {
            this.opts.layoutRoot.style.setProperty('--sidebar-w', `${w}px`);
        };

        applyWidth(clamp(this.sidebarWidth.get()));

        const handle = el('div', {
            class: 'sidebar-resizer',
            attrs: {
                role: 'separator',
                'aria-orientation': 'vertical',
                'aria-label': t('resize'),
                title: t('resizeHint')
            }
        });

        let dragging = false;
        let startX = 0;
        let startW = 0;
        let lastW = this.sidebarWidth.get();

        const onMove = (ev: MouseEvent): void => {
            if (!dragging) return;
            const w = clamp(startW + (ev.clientX - startX));
            lastW = w;
            applyWidth(w);
        };

        const onUp = (): void => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            document.body.classList.remove('synaipse-sidebar-resizing');
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            this.sidebarWidth.set(lastW);
            // A width change reshapes the virtualised list's viewport;
            // re-run the visible window pass.
            this.scheduleVirtualRender();
        };

        const onDown = (ev: MouseEvent): void => {
            // Left button only; ignore right/middle so context-menu still works.
            if (ev.button !== 0) return;
            ev.preventDefault();
            dragging = true;
            startX = ev.clientX;
            startW = clamp(this.sidebarWidth.get());
            lastW = startW;
            handle.classList.add('dragging');
            document.body.classList.add('synaipse-sidebar-resizing');
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        };

        const onDblClick = (): void => {
            applyWidth(SIDEBAR_W_DEFAULT);
            this.sidebarWidth.set(SIDEBAR_W_DEFAULT);
            this.scheduleVirtualRender();
        };

        handle.addEventListener('mousedown', onDown);
        handle.addEventListener('dblclick', onDblClick);

        this.element.appendChild(handle);

        this.detachResize = (): void => {
            handle.removeEventListener('mousedown', onDown);
            handle.removeEventListener('dblclick', onDblClick);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }

    // --- list --------------------------------------------------------------

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

        this.modeSwitcher.appendChild(button('folder', t('modeFolder'), t('byFolder')));
        this.modeSwitcher.appendChild(button('tag', t('modeTag'), t('byTag')));
        this.modeSwitcher.appendChild(button('recent', t('modeRecent'), t('byRecent')));
    }

    private renderEmptyList(title: string, hint: string): void {
        this.rows = [];
        this.rowOffsets = [];
        clear(this.noteList);
        this.noteList.classList.remove('virt');
        this.noteList.style.height = '';
        this.noteList.appendChild(el('li', {class: 'note-list-empty'},
            el('div', {class: 'note-list-empty-title', text: title}),
            el('div', {class: 'note-list-empty-hint', text: hint})
        ));
    }

    /** Re-group, re-count and redraw the visible window of the list. */
    public render(): void {
        const q = this.filter.trim().toLowerCase();
        const visible = q === ''
            ? this.notes
            : this.notes.filter((n) => n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q));

        const total = this.notes.length;

        if (q === '') {
            this.noteCounter.textContent = t('count', {count: total});
        } else {
            this.noteCounter.textContent = t('countFiltered', {visible: visible.length, total});
        }

        if (this.notes.length === 0) {
            this.renderEmptyList(t('emptyTitle'), t('emptyHint'));
            return;
        }

        if (visible.length === 0) {
            this.renderEmptyList(t('noMatchTitle'), t('noMatchHint', {filter: this.filter}));
            return;
        }

        const layout = layoutRows(visible, this.groupMode.get(), this.collapsedGroups.get(), Date.now());
        this.rows = layout.rows;
        this.rowOffsets = layout.offsets;
        this.noteList.classList.add('virt');
        this.noteList.style.height = `${layout.height}px`;

        this.renderVirtualWindow();
    }

    private scheduleVirtualRender(): void {
        if (this.virtualFrame !== null) return;

        this.virtualFrame = window.requestAnimationFrame(() => {
            this.virtualFrame = null;
            this.renderVirtualWindow();
        });
    }

    private renderVirtualWindow(): void {
        if (this.rows.length === 0) return;

        const scrollTop = this.noteList.scrollTop;
        const viewportH = this.noteList.clientHeight || 600;

        const firstVisible = firstRowAt(this.rowOffsets, scrollTop);
        const lastVisible = firstRowAt(this.rowOffsets, scrollTop + viewportH);

        const first = Math.max(0, firstVisible - VIRT_BUFFER);
        const last = Math.min(this.rows.length, lastVisible + VIRT_BUFFER + 1);

        clear(this.noteList);

        for (let i = first; i < last; i += 1) {
            const row = this.rows[i];
            if (row === undefined) continue;

            const top = this.rowOffsets[i] ?? 0;
            this.noteList.appendChild(this.renderRow(row, top));
        }
    }

    private renderRow(row: VirtualRow, top: number): HTMLElement {
        if (row.kind === 'group') {
            // Show the + affordance only in folder mode. In tag/recent modes
            // the key is a tag name / bucket label, not a vault-relative
            // parent path, so a "new here" button would misroute.
            const showAdd = this.groupMode.get() === 'folder' && row.group.key.length > 0;

            // A real button toggles the group (keyboard, aria-expanded); the
            // row stays a list item and the + button sits next to it, not
            // inside (no nested interactive controls).
            const children: HTMLElement[] = [
                el('button', {
                    class: 'note-group-toggle',
                    attrs: {
                        type: 'button',
                        'aria-expanded': row.isCollapsed ? 'false' : 'true',
                        title: t('toggleGroup', {folder: row.group.label})
                    },
                    on: {click: () => this.toggleGroup(row.key)}
                },
                    el('span', {class: 'note-group-caret', text: '▾', attrs: {'aria-hidden': 'true'}}),
                    el('span', {class: 'note-group-label', text: row.group.label}),
                    el('span', {class: 'note-group-count', text: String(row.totalCount)})
                )
            ];

            if (showAdd) {
                const folderKey = row.group.key;
                children.push(el('button', {
                    class: 'note-group-add',
                    attrs: {
                        type: 'button',
                        title: t('newIn', {folder: `${folderKey}/`}),
                        'aria-label': t('newIn', {folder: folderKey})
                    },
                    text: '+',
                    on: {click: () => this.opts.onNewInFolder(folderKey)}
                }));
            }

            return el('li', {
                class: row.isCollapsed ? 'note-group-header collapsed' : 'note-group-header',
                style: {
                    top: `${top}px`,
                    height: `${GROUP_ROW_H}px`,
                    paddingLeft: `${8 + row.depth * 14}px`
                }
            }, ...children);
        }

        const n = row.note;
        const meta = el('div', {class: 'note-list-meta'},
            el('span', {class: 'note-list-path', text: n.id})
        );

        if (n.tags.length > 0) {
            const chipHost = el('div', {class: 'note-list-tags'});

            for (const tag of n.tags.slice(0, 3)) {
                const color = tagColor(tag);
                chipHost.appendChild(applyTagText(el('span', {
                    class: 'note-list-tag',
                    text: tag,
                    style: {borderColor: color}
                }), tag));
            }

            if (n.tags.length > 3) {
                chipHost.appendChild(el('span', {class: 'note-list-tag-more', text: `+${n.tags.length - 3}`}));
            }

            meta.appendChild(chipHost);
        }

        const lockIcon = n.isPrivate === true
            ? el('span', {
                class: 'note-list-lock',
                text: '🔒',
                attrs: {title: t('private')}
            })
            : null;

        const draftDot = this.draftIds.has(n.id)
            ? el('span', {
                class: 'note-list-draft',
                text: '●',
                attrs: {title: t('draft')}
            })
            : null;

        return el('li', {
            class: n.id === this.activeId ? 'note-list-item active' : 'note-list-item',
            style: {
                top: `${top}px`,
                height: `${noteRowHeight(n)}px`,
                paddingLeft: `${12 + row.depth * 14}px`
            },
            on: {click: () => this.opts.onSelect(n.id)}
        },
            el('div', {class: 'note-list-title'}, draftDot, lockIcon, n.title),
            meta
        );
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
}
