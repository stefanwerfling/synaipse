import type {Note} from '@synaipse/core';
import {extractTypedLinks} from '@synaipse/core';
import {api, NoteSummary, SummarizeEvent} from './Api.js';
import {tagColor} from './Colors.js';
import {clear, el} from './Dom.js';
import {listDraftIds} from './Drafts.js';
import {Editor} from './Editor.js';
import {HistoryPanel} from './HistoryPanel.js';
import {clipSnippet} from './HoverCard.js';
import {MarkdownPreview, NoteSnippet} from './MarkdownPreview.js';
import {PersistentValue, setCodec} from './Persistence.js';
import {extractToc, TocPanel} from './Toc.js';
import {buildWikilinkResolver, slugify, WikilinkResolver} from './Wikilinks.js';
import {fuzzyMatch} from './Fuzzy.js';
import type {WikilinkMatch} from './WikilinkAutocomplete.js';

export interface NotesPanelOptions {
    onNotesChanged: () => void;
    onAskAboutSelection?: (noteId: string, selection: string) => void;
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

interface OverflowItem {
    label: string;
    title: string;
    danger?: boolean;
    onSelect: () => void;
}

const GROUP_ROW_H = 32;
// Two heights so the row box is large enough for whatever it actually paints.
// With tags, the meta column adds gap + a ~17px chip row that previously
// overflowed a hard-coded 56px box and overlapped the next item by ~16px.
const NOTE_ROW_H_PLAIN = 56;
const NOTE_ROW_H_TAGGED = 76;
const noteRowHeight = (note: NoteSummary): number =>
    note.tags.length > 0 ? NOTE_ROW_H_TAGGED : NOTE_ROW_H_PLAIN;
const VIRT_BUFFER = 8;

type VirtualRow =
    | {kind: 'group'; group: NoteGroup; key: string; isCollapsed: boolean; depth: number; totalCount: number}
    | {kind: 'note'; note: NoteSummary; depth: number};

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

// Top-level folders whose immediate subdirs are usually opaque IDs (UUIDs,
// hashes, dates) that would explode the tree with noise. We collapse the
// entire subtree of such folders into a single flat bucket at the top
// folder's node.
const FLAT_TOP_LEVEL_FOLDERS = new Set(['chatgpt-import', 'Clipped']);

interface FolderNode {
    path: string;    // full vault-relative path, e.g. "Memory/decisions"
    label: string;   // leaf segment, e.g. "decisions"
    notes: NoteSummary[];
    children: FolderNode[];
}

/**
 * Build a nested folder tree from note IDs. Each `/`-separated segment
 * becomes a node; notes attach to their exact leaf folder. Notes in the
 * vault root land on the returned root node's `notes` array (its `path`
 * and `label` are empty).
 *
 * `FLAT_TOP_LEVEL_FOLDERS` are collapsed: everything under `chatgpt-import/`
 * lands directly on that top-level node's `notes`, with no descendants.
 * This keeps the tree navigable when a folder holds hundreds of opaque
 * UUID subdirectories.
 */
const buildFolderTree = (notes: NoteSummary[]): FolderNode => {
    const root: FolderNode = {path: '', label: '', notes: [], children: []};
    const byPath = new Map<string, FolderNode>([['', root]]);

    for (const note of notes) {
        const slash = note.id.lastIndexOf('/');
        if (slash === -1) {
            root.notes.push(note);
            continue;
        }

        const folder = note.id.slice(0, slash);
        const parts = folder.split('/');
        const top = parts[0] ?? '';

        if (FLAT_TOP_LEVEL_FOLDERS.has(top)) {
            let node = byPath.get(top);
            if (node === undefined) {
                node = {path: top, label: top, notes: [], children: []};
                byPath.set(top, node);
                root.children.push(node);
            }
            node.notes.push(note);
            continue;
        }

        let acc = '';
        let parent = root;
        for (const part of parts) {
            acc = acc.length > 0 ? `${acc}/${part}` : part;
            let node = byPath.get(acc);
            if (node === undefined) {
                node = {path: acc, label: part, notes: [], children: []};
                byPath.set(acc, node);
                parent.children.push(node);
            }
            parent = node;
        }
        parent.notes.push(note);
    }

    const sortRec = (node: FolderNode): void => {
        node.children.sort((a, b) => a.label.localeCompare(b.label));
        node.notes.sort((a, b) => a.title.localeCompare(b.title));
        for (const c of node.children) sortRec(c);
    };
    sortRec(root);

    return root;
};

const countRec = (node: FolderNode): number => {
    let total = node.notes.length;
    for (const c of node.children) total += countRec(c);
    return total;
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

const DEFAULT_CREATE_FOLDER = 'Memory/scratch';

const folderOfNoteId = (id: string): string | null => {
    const slash = id.lastIndexOf('/');
    return slash === -1 ? null : id.slice(0, slash);
};

const STORAGE_SIDEBAR_W = 'synaipse.notes.sidebarWidth';
const SIDEBAR_W_DEFAULT = 320;
const SIDEBAR_W_MIN = 220;
const SIDEBAR_W_MAX = 640;

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
    private tocPanel!: TocPanel;
    private tocObserver: IntersectionObserver | null = null;
    private tocVisible = new Set<string>();
    private tocOrder = new Map<string, number>();
    private tocClickPinTimer: number | null = null;
    private tocFlashTimer: number | null = null;
    private tocFlashTarget: HTMLElement | null = null;
    private overflowCloser: (() => void) | null = null;
    private draftIds = new Set<string>();
    private filterInput!: HTMLInputElement;
    private noteList!: HTMLUListElement;
    private noteCounter!: HTMLElement;
    private modeSwitcher!: HTMLElement;
    private createRow!: HTMLElement;
    private createInput!: HTMLInputElement;
    private createHint!: HTMLElement;
    private createContext: {folder: string; title?: string} | null = null;

    private readonly groupMode = new PersistentValue<GroupMode>(STORAGE_GROUP_MODE, 'folder');
    private readonly collapsedGroups = new PersistentValue<ReadonlySet<string>>(STORAGE_COLLAPSED, new Set(), setCodec);
    // 250ms debounce is short enough to feel instant on the next reload but
    // slow enough that a drag doesn't hammer localStorage on every mousemove.
    private readonly sidebarWidth = new PersistentValue<number>(STORAGE_SIDEBAR_W, SIDEBAR_W_DEFAULT, undefined, 250);
    private unsubscribeGroupMode: () => void = () => {};
    private unsubscribeCollapsed: () => void = () => {};
    private detachSidebarResize: () => void = () => {};

    private viewerPreview: MarkdownPreview | null = null;
    private currentEditor: Editor | null = null;
    private historyPanel: HistoryPanel | null = null;
    private historyEnabled = false;
    private chatEnabled = false;
    private selectionBtn: HTMLButtonElement | null = null;
    private summarizeAbort: AbortController | null = null;
    private selectionListenersAttached = false;

    // virtualised list state
    private flatRows: VirtualRow[] = [];
    private rowOffsets: number[] = [];
    private totalListHeight = 0;
    private virtualFrame: number | null = null;

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
        this.draftIds = listDraftIds();
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

    public destroy(): void {
        this.disposeViewer();
        this.disposeEditor();
        this.disposeTocObserver();
        this.closeOverflowMenu();
        this.unsubscribeGroupMode();
        this.unsubscribeCollapsed();
        this.detachSidebarResize();
        this.sidebarWidth.destroy();

        if (this.selectionBtn !== null) {
            this.selectionBtn.remove();
            this.selectionBtn = null;
        }
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

        this.createInput = el('input', {
            class: 'create-row-input',
            attrs: {type: 'text', placeholder: 'Name…', 'aria-label': 'Note name'},
            on: {keydown: (e) => this.onCreateInputKey(e as KeyboardEvent)}
        }) as HTMLInputElement;
        this.createHint = el('div', {class: 'create-row-hint'});
        this.createRow = el('div', {class: 'create-row', attrs: {hidden: 'hidden'}},
            this.createHint,
            this.createInput
        );

        this.noteCounter = el('div', {class: 'sidebar-counter', text: '0 notes'});

        this.noteList = el('ul', {
            class: 'note-list',
            on: {scroll: () => this.scheduleVirtualRender()}
        }) as HTMLUListElement;

        this.sidebar = el('aside', {class: 'sidebar'}, head, this.modeSwitcher, this.createRow, this.noteCounter, this.noteList);
        this.installSidebarResizer();

        this.tocPanel = new TocPanel({
            onNavigate: (id) => this.scrollToHeading(id)
        });

        this.viewer = el('main', {class: 'viewer'});
        this.renderEmpty();

        this.element.appendChild(this.sidebar);
        this.element.appendChild(this.viewer);
    }

    /**
     * Draggable resizer at the sidebar's right border. Width is driven by
     * `--sidebar-w` on `.app`, which the grid template consumes; a debounced
     * PersistentValue writes to localStorage so a live drag doesn't hammer
     * disk. Clamped between MIN and MAX to avoid unusable extremes.
     * Double-click resets to the default width.
     */
    private installSidebarResizer(): void {
        const clamp = (w: number): number => Math.max(SIDEBAR_W_MIN, Math.min(SIDEBAR_W_MAX, w));

        const applyWidth = (w: number): void => {
            this.element.style.setProperty('--sidebar-w', `${w}px`);
        };

        applyWidth(clamp(this.sidebarWidth.get()));

        const handle = el('div', {
            class: 'sidebar-resizer',
            attrs: {
                role: 'separator',
                'aria-orientation': 'vertical',
                'aria-label': 'Resize sidebar',
                title: 'Drag to resize, double-click to reset'
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
            document.body.classList.remove('sidebar-resizing');
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            this.sidebarWidth.set(lastW);
            // A width change reshapes the virtualised note list's viewport;
            // re-run the visible window pass so scrollbar heuristics stay
            // consistent with the new column width.
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
            document.body.classList.add('sidebar-resizing');
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

        this.sidebar.appendChild(handle);

        this.detachSidebarResize = (): void => {
            handle.removeEventListener('mousedown', onDown);
            handle.removeEventListener('dblclick', onDblClick);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }

    /**
     * Scroll the note viewport so the clicked heading sits at the top,
     * and pin the TOC's active state to the clicked entry until the
     * smooth scroll settles. Without the pin, the scroll-spy observer
     * would immediately re-highlight whichever heading falls inside its
     * 20–30% band — usually the NEXT heading below the clicked one,
     * which is exactly the "target entry doesn't get focus" bug.
     *
     * Explicit `viewer.scrollTo` (not `scrollIntoView`) because both
     * `.viewer` and `.md-preview` carry `overflow-y: auto`, and browsers
     * disagree about which one `scrollIntoView` should touch.
     */
    private scrollToHeading(id: string): void {
        if (this.viewerPreview === null) return;
        const target = this.viewerPreview.element.querySelector<HTMLElement>(`[id="${id}"]`);
        if (target === null) return;

        const viewerRect = this.viewer.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const offset = targetRect.top - viewerRect.top + this.viewer.scrollTop;

        this.tocPanel.setActive(id);
        this.pinTocActive();
        this.flashHeading(target);

        this.viewer.scrollTo({
            top: Math.max(0, offset - 8),
            behavior: 'smooth'
        });
    }

    /**
     * Briefly highlight the target heading so the user sees where the
     * click landed. Re-triggering (same heading clicked twice, or a new
     * entry mid-animation) restarts the effect cleanly.
     */
    private flashHeading(target: HTMLElement): void {
        if (this.tocFlashTimer !== null) {
            window.clearTimeout(this.tocFlashTimer);
            this.tocFlashTimer = null;
        }
        if (this.tocFlashTarget !== null) {
            this.tocFlashTarget.classList.remove('toc-flash');
        }
        // Force reflow so re-adding the class restarts the CSS animation.
        void target.offsetWidth;
        target.classList.add('toc-flash');
        this.tocFlashTarget = target;
        this.tocFlashTimer = window.setTimeout(() => {
            target.classList.remove('toc-flash');
            if (this.tocFlashTarget === target) this.tocFlashTarget = null;
            this.tocFlashTimer = null;
        }, 1600);
    }

    /**
     * Suppress scroll-spy driven `setActive` calls for ~800ms so a
     * user-initiated navigation isn't clobbered by the observer picking
     * a nearby heading as the scroll passes through.
     */
    private pinTocActive(): void {
        if (this.tocClickPinTimer !== null) {
            window.clearTimeout(this.tocClickPinTimer);
        }
        this.tocClickPinTimer = window.setTimeout(() => {
            this.tocClickPinTimer = null;
            // After the pin lifts, resync from the current scroll pos so
            // the highlight matches what the user is actually looking at.
            this.refreshTocActive();
        }, 800);
    }

    private updateToc(): void {
        this.disposeTocObserver();

        if (this.viewerPreview === null) {
            this.tocPanel.setEntries([]);
            this.tocPanel.element.remove();
            this.element.classList.remove('has-toc');
            return;
        }

        const entries = extractToc(this.viewerPreview.element);
        this.tocPanel.setEntries(entries);

        if (entries.length === 0) {
            this.tocPanel.element.remove();
            this.element.classList.remove('has-toc');
            return;
        }

        if (!this.tocPanel.element.isConnected) {
            this.element.insertBefore(this.tocPanel.element, this.viewer);
        }
        this.element.classList.add('has-toc');

        this.installTocObserver(entries.map((e) => e.id));
    }

    /**
     * Scroll-spy: track which headings intersect the top band of the
     * viewer viewport and mark the topmost visible one as active. The
     * band starts at viewport top and ends at 30% down (rootMargin
     * `0 0 -70% 0`) so a heading scrolled to the very top by a TOC
     * click stays inside the band and remains highlighted — the earlier
     * 20% start was excluding exactly the intended target.
     */
    private installTocObserver(ids: readonly string[]): void {
        this.tocVisible.clear();
        this.tocOrder = new Map(ids.map((id, i) => [id, i]));

        const headings: HTMLElement[] = [];
        for (const id of ids) {
            const h = this.viewerPreview?.element.querySelector(`[id="${id}"]`);
            if (h instanceof HTMLElement) headings.push(h);
        }

        if (headings.length === 0) return;

        this.tocObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const id = (entry.target as HTMLElement).id;
                if (entry.isIntersecting) {
                    this.tocVisible.add(id);
                } else {
                    this.tocVisible.delete(id);
                }
            }

            this.refreshTocActive();
        }, {
            root: this.viewer,
            rootMargin: '0px 0px -70% 0px',
            threshold: 0
        });

        for (const h of headings) {
            this.tocObserver.observe(h);
        }
    }

    private refreshTocActive(): void {
        // User just clicked a TOC entry — don't let the observer override
        // the deliberate selection while the smooth scroll runs. Once the
        // pin lifts, this method is called explicitly to resync.
        if (this.tocClickPinTimer !== null) {
            return;
        }

        if (this.tocVisible.size === 0) {
            // Nothing in the band — pick whichever heading is furthest above
            // the top edge of the viewport instead of blanking the outline.
            const closest = this.closestHeadingAboveViewport();
            this.tocPanel.setActive(closest);
            return;
        }

        let best: string | null = null;
        let bestOrder = Infinity;
        for (const id of this.tocVisible) {
            const order = this.tocOrder.get(id) ?? Infinity;
            if (order < bestOrder) {
                bestOrder = order;
                best = id;
            }
        }

        this.tocPanel.setActive(best);
    }

    private closestHeadingAboveViewport(): string | null {
        if (this.viewerPreview === null) return null;

        const viewerTop = this.viewer.getBoundingClientRect().top;
        let best: string | null = null;
        let bestTop = -Infinity;

        for (const id of this.tocOrder.keys()) {
            const h = this.viewerPreview.element.querySelector(`[id="${id}"]`);
            if (!(h instanceof HTMLElement)) continue;
            const top = h.getBoundingClientRect().top - viewerTop;
            if (top <= 0 && top > bestTop) {
                bestTop = top;
                best = id;
            }
        }

        return best;
    }

    private disposeTocObserver(): void {
        if (this.tocObserver !== null) {
            this.tocObserver.disconnect();
            this.tocObserver = null;
        }
        if (this.tocClickPinTimer !== null) {
            window.clearTimeout(this.tocClickPinTimer);
            this.tocClickPinTimer = null;
        }
        this.tocVisible.clear();
        this.tocOrder.clear();
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

        const total = this.notes.length;

        if (q === '') {
            this.noteCounter.textContent = total === 1 ? '1 note' : `${total} notes`;
        } else {
            this.noteCounter.textContent = `${visible.length} of ${total}`;
        }

        if (this.notes.length === 0) {
            this.flatRows = [];
            this.rowOffsets = [];
            this.totalListHeight = 0;
            clear(this.noteList);
            this.noteList.classList.remove('virt');
            this.noteList.style.height = '';
            this.noteList.appendChild(el('li', {class: 'note-list-empty'},
                el('div', {class: 'note-list-empty-title', text: 'No notes yet'}),
                el('div', {class: 'note-list-empty-hint', text: 'Click + New to create your first note.'})
            ));
            return;
        }

        if (visible.length === 0) {
            this.flatRows = [];
            this.rowOffsets = [];
            this.totalListHeight = 0;
            clear(this.noteList);
            this.noteList.classList.remove('virt');
            this.noteList.style.height = '';
            this.noteList.appendChild(el('li', {class: 'note-list-empty'},
                el('div', {class: 'note-list-empty-title', text: 'No matches'}),
                el('div', {class: 'note-list-empty-hint', text: `No notes match "${this.filter}".`})
            ));
            return;
        }

        const mode = this.groupMode.get();
        const collapsed = this.collapsedGroups.get();

        this.flatRows = [];
        this.rowOffsets = [];

        let offset = 0;

        if (mode === 'folder') {
            const root = buildFolderTree(visible);

            // Root-level notes (no folder) render at depth 0 with no header
            // — a "/" bucket only added a click-target for nothing.
            for (const n of root.notes) {
                this.flatRows.push({kind: 'note', note: n, depth: 0});
                this.rowOffsets.push(offset);
                offset += noteRowHeight(n);
            }

            const walk = (node: FolderNode, depth: number): void => {
                const groupKey = `folder:${node.path}`;
                const isCollapsed = collapsed.has(groupKey);
                const group: NoteGroup = {key: node.path, label: node.label, notes: node.notes};
                const totalCount = countRec(node);

                this.flatRows.push({kind: 'group', group, key: groupKey, isCollapsed, depth, totalCount});
                this.rowOffsets.push(offset);
                offset += GROUP_ROW_H;

                if (isCollapsed) return;

                // Subfolders first, then direct notes at this level — matches
                // conventional file-explorer ordering.
                for (const child of node.children) {
                    walk(child, depth + 1);
                }
                for (const n of node.notes) {
                    this.flatRows.push({kind: 'note', note: n, depth: depth + 1});
                    this.rowOffsets.push(offset);
                    offset += noteRowHeight(n);
                }
            };

            for (const child of root.children) {
                walk(child, 0);
            }
        } else {
            const groups = buildGroups(visible, mode, Date.now());
            for (const group of groups) {
                const groupKey = `${mode}:${group.key}`;
                const isCollapsed = collapsed.has(groupKey);

                this.flatRows.push({
                    kind: 'group', group, key: groupKey, isCollapsed,
                    depth: 0, totalCount: group.notes.length
                });
                this.rowOffsets.push(offset);
                offset += GROUP_ROW_H;

                if (!isCollapsed) {
                    for (const n of group.notes) {
                        this.flatRows.push({kind: 'note', note: n, depth: 0});
                        this.rowOffsets.push(offset);
                        offset += noteRowHeight(n);
                    }
                }
            }
        }

        this.totalListHeight = offset;
        this.noteList.classList.add('virt');
        this.noteList.style.height = `${offset}px`;

        this.renderVirtualWindow();
    }

    private scheduleVirtualRender(): void {
        if (this.virtualFrame !== null) return;

        this.virtualFrame = window.requestAnimationFrame(() => {
            this.virtualFrame = null;
            this.renderVirtualWindow();
        });
    }

    private findFirstVisibleRow(scrollTop: number): number {
        // binary search over rowOffsets
        let lo = 0;
        let hi = this.rowOffsets.length;

        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if ((this.rowOffsets[mid] ?? 0) <= scrollTop) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }

        return Math.max(0, lo - 1);
    }

    private renderVirtualWindow(): void {
        if (this.flatRows.length === 0) return;

        const scrollTop = this.noteList.scrollTop;
        const viewportH = this.noteList.clientHeight || 600;

        const firstVisible = this.findFirstVisibleRow(scrollTop);
        const lastVisible = this.findFirstVisibleRow(scrollTop + viewportH);

        const first = Math.max(0, firstVisible - VIRT_BUFFER);
        const last = Math.min(this.flatRows.length, lastVisible + VIRT_BUFFER + 1);

        clear(this.noteList);

        for (let i = first; i < last; i += 1) {
            const row = this.flatRows[i];
            if (row === undefined) continue;

            const top = this.rowOffsets[i] ?? 0;
            this.noteList.appendChild(this.renderVirtualRow(row, top));
        }
    }

    private renderVirtualRow(row: VirtualRow, top: number): HTMLElement {
        if (row.kind === 'group') {
            // Show the + affordance only in folder mode. In tag/recent modes
            // the key is a tag name / bucket label, not a vault-relative
            // parent path, so a "new here" button would misroute.
            const showAdd = this.groupMode.get() === 'folder' && row.group.key.length > 0;

            const children: HTMLElement[] = [
                el('span', {class: 'note-group-caret', text: '▾'}),
                el('span', {class: 'note-group-label', text: row.group.label}),
                el('span', {class: 'note-group-count', text: String(row.totalCount)})
            ];

            if (showAdd) {
                const folderKey = row.group.key;
                children.push(el('button', {
                    class: 'note-group-add',
                    attrs: {
                        type: 'button',
                        title: `New note in ${folderKey}/`,
                        'aria-label': `New note in ${folderKey}`
                    },
                    text: '+',
                    on: {click: (ev) => {
                        // Prevent the header click from collapsing the group.
                        ev.stopPropagation();
                        this.handleNewInFolder(folderKey);
                    }}
                }));
            }

            const header = el('li', {
                class: row.isCollapsed ? 'note-group-header collapsed' : 'note-group-header',
                attrs: {role: 'button', tabindex: '0'},
                style: {
                    top: `${top}px`,
                    height: `${GROUP_ROW_H}px`,
                    paddingLeft: `${8 + row.depth * 14}px`
                },
                on: {click: () => this.toggleGroup(row.key)}
            }, ...children);
            return header;
        }

        const n = row.note;
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

        const lockIcon = n.isPrivate === true
            ? el('span', {
                class: 'note-list-lock',
                text: '🔒',
                attrs: {title: 'DSGVO: privat — wird nicht an externe LLMs gesendet'}
            })
            : null;

        const draftDot = this.draftIds.has(n.id)
            ? el('span', {
                class: 'note-list-draft',
                text: '●',
                attrs: {title: 'Unsaved draft'}
            })
            : null;

        return el('li', {
            class: n.id === this.activeId ? 'note-list-item active' : 'note-list-item',
            style: {
                top: `${top}px`,
                height: `${noteRowHeight(n)}px`,
                paddingLeft: `${12 + row.depth * 14}px`
            },
            on: {click: () => this.handleSelect(n.id)}
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
        this.openCreateRow();
    }

    private handleNewInFolder = (folder: string): void => {
        if (!this.confirmDiscardIfDirty('You have unsaved changes. Discard and create a new note?')) {
            return;
        }
        this.openCreateRow({folder});
    };

    /**
     * Default folder for a new note: the currently-active note's folder when
     * one exists, else the fixed fallback. Keeps "+ New" context-aware — when
     * you're deep in `Memory/decisions/`, the new note lands there without
     * you re-typing the path.
     */
    private defaultCreateFolder(): string {
        if (this.active !== null) {
            const folder = folderOfNoteId(this.active.id);
            if (folder !== null && folder.length > 0) return folder;
        }
        return DEFAULT_CREATE_FOLDER;
    }

    private openCreateRow(context: {folder?: string; title?: string} = {}): void {
        const folder = (context.folder ?? this.defaultCreateFolder()).replace(/\/+$/, '');
        this.createContext = context.title !== undefined
            ? {folder, title: context.title}
            : {folder};
        this.createHint.classList.remove('create-row-hint-error');
        this.createHint.textContent = `in ${folder.length > 0 ? folder + '/' : '/'}`;
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
            const note = await api.writeNote({path, content: '', frontmatter: {title}});
            this.closeCreateRow();
            this.opts.onNotesChanged();
            this.activeId = note.id;
            this.active = note;
            this.editing = true;
            this.renderEditor();
        } catch (e) {
            this.createHint.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
            this.createHint.classList.add('create-row-hint-error');
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

    private createFromWikilink = (title: string): void => {
        // Wikilink `[[X]]` for a missing note: seed the inline row with X as
        // both the derived slug and the frontmatter title, and default the
        // folder to the current note's folder (falling back to
        // Memory/research so wikilink-created stubs still land somewhere
        // reasonable when there's no active note).
        const folder = this.active !== null
            ? folderOfNoteId(this.active.id) ?? 'Memory/research'
            : 'Memory/research';
        this.openCreateRow({folder, title});
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

    /**
     * Folder path as breadcrumb (`Memory ▸ decisions ▸ 2026-06-11-foo.md`).
     * Returns an empty container for root-level notes so the h1 sits
     * flush against the top of the head. Terminal segment is the file
     * name (still useful — the title displayed below is often different).
     */
    private buildBreadcrumb(noteId: string): HTMLElement {
        const parts = noteId.split('/').filter((p) => p.length > 0);

        if (parts.length <= 1) {
            return el('div', {class: 'viewer-breadcrumb empty'});
        }

        const host = el('div', {class: 'viewer-breadcrumb', attrs: {title: noteId}});

        parts.forEach((part, i) => {
            if (i > 0) {
                host.appendChild(el('span', {class: 'viewer-breadcrumb-sep', text: '›'}));
            }
            const isLast = i === parts.length - 1;
            host.appendChild(el('span', {
                class: isLast ? 'viewer-breadcrumb-part last' : 'viewer-breadcrumb-part',
                text: part
            }));
        });

        return host;
    }

    /**
     * Overflow menu ("⋯") for secondary actions. The dropdown is anchored
     * to the trigger via a `position: relative` wrapper. Outside-click
     * and Escape close it; we install those listeners on open and tear
     * them down on close, tracked via `overflowCloser` so a re-render
     * can dismiss a stale open menu.
     */
    private buildOverflowMenu(items: readonly OverflowItem[]): HTMLElement {
        const menu = el('div', {class: 'viewer-overflow-menu', attrs: {role: 'menu'}});

        const wrap = el('div', {class: 'viewer-overflow'});

        const trigger = el('button', {
            class: 'btn btn-overflow',
            attrs: {type: 'button', 'aria-label': 'More actions', 'aria-haspopup': 'menu', 'aria-expanded': 'false'},
            text: '⋯'
        }) as HTMLButtonElement;

        const close = (): void => {
            wrap.classList.remove('open');
            trigger.setAttribute('aria-expanded', 'false');
            document.removeEventListener('mousedown', onDocDown, true);
            document.removeEventListener('keydown', onKey, true);
            this.overflowCloser = null;
        };

        const onDocDown = (ev: MouseEvent): void => {
            if (!wrap.contains(ev.target as Node)) close();
        };
        const onKey = (ev: KeyboardEvent): void => {
            if (ev.key === 'Escape') close();
        };

        const open = (): void => {
            this.overflowCloser?.();
            wrap.classList.add('open');
            trigger.setAttribute('aria-expanded', 'true');
            document.addEventListener('mousedown', onDocDown, true);
            document.addEventListener('keydown', onKey, true);
            this.overflowCloser = close;
        };

        trigger.addEventListener('click', () => {
            if (wrap.classList.contains('open')) close();
            else open();
        });

        for (const item of items) {
            menu.appendChild(el('button', {
                class: item.danger === true ? 'viewer-overflow-item danger' : 'viewer-overflow-item',
                attrs: {type: 'button', role: 'menuitem', title: item.title},
                text: item.label,
                on: {click: () => {
                    close();
                    item.onSelect();
                }}
            }));
        }

        wrap.appendChild(trigger);
        wrap.appendChild(menu);
        return wrap;
    }

    private closeOverflowMenu(): void {
        this.overflowCloser?.();
    }

    /**
     * Re-scan localStorage for draft keys. Called from the Editor's
     * dirty-change callback (fires on every edit and on save/discard),
     * cheap enough that we don't need to diff, and keeps the sidebar
     * ● markers accurate without a global bus.
     */
    private refreshDrafts(): void {
        const next = listDraftIds();
        const changed = next.size !== this.draftIds.size
            || [...next].some((id) => !this.draftIds.has(id));

        if (!changed) return;

        this.draftIds = next;
        this.renderNoteList();
    }

    private renderEmpty(): void {
        this.disposeViewer();
        this.disposeEditor();
        this.closeOverflowMenu();
        clear(this.viewer);
        this.updateToc();

        const empty = el('div', {class: 'viewer-empty'},
            el('div', {class: 'viewer-empty-icon', text: '◌'}),
            el('h2', {class: 'viewer-empty-title', text: 'No note selected'}),
            el('p', {class: 'viewer-empty-hint', text: 'Pick a note from the sidebar or create a new one to get started.'})
        );

        this.viewer.appendChild(empty);
    }

    private renderLoading(): void {
        this.closeOverflowMenu();
        clear(this.viewer);
        this.updateToc();
        this.viewer.appendChild(el('p', {class: 'loading', text: 'loading…'}));
    }

    private renderError(error: unknown): void {
        this.closeOverflowMenu();
        clear(this.viewer);
        this.updateToc();
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

        const overflowItems: OverflowItem[] = [];

        if (this.chatEnabled) {
            overflowItems.push({
                label: 'Summarize',
                title: 'Generate an LLM summary of this note',
                onSelect: () => void this.openSummarizeModal()
            });
        }

        if (this.historyEnabled) {
            overflowItems.push({
                label: 'History',
                title: 'Show change history',
                onSelect: () => void this.toggleHistory()
            });
        }

        overflowItems.push({
            label: 'Delete',
            title: 'Delete this note',
            danger: true,
            onSelect: () => void this.handleDelete()
        });

        const editBtn = el('button', {
            class: 'btn',
            attrs: {type: 'button'},
            text: 'Edit',
            on: {click: () => this.startEditing()}
        });

        const actions: HTMLElement[] = [editBtn, this.buildOverflowMenu(overflowItems)];

        const info = el('div', {class: 'viewer-head-info'},
            this.buildBreadcrumb(this.active.id),
            el('h1', {text: this.active.title})
        );

        const head = el('div', {class: 'viewer-head'},
            info,
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
        this.viewerPreview.setNoteId(this.active.id);
        this.viewerPreview.update(this.active.content);
        this.viewerPreview.setTypedLinks(extractTypedLinks(this.active.frontmatter));
        this.renderLinks();
        this.attachSelectionListener();
        this.updateToc();
    }

    private attachSelectionListener(): void {
        if (this.viewerPreview === null) return;
        if (this.opts.onAskAboutSelection === undefined) return;
        if (!this.chatEnabled) return;
        if (this.selectionListenersAttached) return;

        this.selectionListenersAttached = true;

        const onUp = (): void => {
            if (this.viewerPreview === null) return;
            const host = this.viewerPreview.element;
            window.setTimeout(() => this.showSelectionButton(host), 0);
        };

        document.addEventListener('mouseup', onUp);
        document.addEventListener('keyup', onUp);
        document.addEventListener('selectionchange', () => {
            const sel = window.getSelection();
            if (sel === null || sel.toString().trim().length === 0) {
                this.hideSelectionButton();
            }
        });
    }

    private showSelectionButton(host: HTMLElement): void {
        const sel = window.getSelection();
        if (sel === null) return;

        const text = sel.toString().trim();
        if (text.length < 4) {
            this.hideSelectionButton();
            return;
        }

        if (sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);

        // selection must be inside the preview host
        if (!host.contains(range.commonAncestorContainer)) {
            this.hideSelectionButton();
            return;
        }

        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        if (this.selectionBtn === null) {
            this.selectionBtn = el('button', {
                class: 'selection-action',
                attrs: {type: 'button'},
                text: '↳ Ask about this',
                on: {mousedown: (e) => e.preventDefault()}
            }) as HTMLButtonElement;
            document.body.appendChild(this.selectionBtn);
        }

        const btn = this.selectionBtn;
        btn.onclick = (): void => {
            if (this.activeId === null || this.opts.onAskAboutSelection === undefined) return;
            this.opts.onAskAboutSelection(this.activeId, text);
            this.hideSelectionButton();
            const live = window.getSelection();
            if (live !== null) live.removeAllRanges();
        };

        const top = window.scrollY + rect.top - 40;
        const left = window.scrollX + rect.left + rect.width / 2 - 80;
        btn.style.top = `${Math.max(8, top)}px`;
        btn.style.left = `${Math.max(8, left)}px`;
        btn.style.display = 'block';
    }

    private hideSelectionButton(): void {
        if (this.selectionBtn !== null) {
            this.selectionBtn.style.display = 'none';
        }
    }

    private async openSummarizeModal(): Promise<void> {
        if (this.active === null) return;
        const noteId = this.active.id;

        const overlay = el('div', {class: 'summarize-modal-overlay'});
        const body = el('div', {class: 'summarize-modal-body'});
        const status = el('div', {class: 'summarize-modal-status', text: 'streaming…'});
        const closeBtn = el('button', {
            class: 'btn',
            attrs: {type: 'button'},
            text: 'Close',
            on: {click: () => this.closeSummarizeModal(overlay)}
        });
        const saveBtn = el('button', {
            class: 'btn btn-primary',
            attrs: {type: 'button', disabled: 'true'},
            text: 'Save to frontmatter.summary'
        }) as HTMLButtonElement;

        const modal = el('div', {class: 'summarize-modal'},
            el('div', {class: 'summarize-modal-head'},
                el('h3', {text: `Summarize · ${this.active.title}`}),
                status
            ),
            body,
            el('div', {class: 'summarize-modal-actions'}, closeBtn, saveBtn)
        );

        overlay.appendChild(modal);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.closeSummarizeModal(overlay);
        });

        document.body.appendChild(overlay);

        const ctl = new AbortController();
        this.summarizeAbort = ctl;

        let finalSummary = '';
        let acc = '';

        try {
            for await (const event of api.summarizeNote(noteId, {signal: ctl.signal})) {
                this.handleSummarizeEvent(event, body, status, (s) => { finalSummary = s; }, (chunk) => { acc += chunk; });
            }

            if (finalSummary.length > 0) {
                saveBtn.removeAttribute('disabled');
                saveBtn.onclick = async (): Promise<void> => {
                    saveBtn.setAttribute('disabled', 'true');
                    saveBtn.textContent = 'saving…';
                    try {
                        await this.saveSummaryToFrontmatter(noteId, finalSummary);
                        saveBtn.textContent = '✓ Saved';
                        window.setTimeout(() => this.closeSummarizeModal(overlay), 800);
                    } catch (cause) {
                        saveBtn.textContent = 'Save failed';
                        status.textContent = String(cause);
                    }
                };
            }
        } catch (cause) {
            if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
                status.textContent = `error: ${String(cause)}`;
            }
        } finally {
            this.summarizeAbort = null;
            if (acc.length > 0 && finalSummary.length === 0) {
                // stream cut off — show what we got
                finalSummary = acc.trim();
            }
        }
    }

    private handleSummarizeEvent(
        event: SummarizeEvent,
        body: HTMLElement,
        status: HTMLElement,
        setFinal: (s: string) => void,
        addToken: (t: string) => void
    ): void {
        if (event.kind === 'token') {
            addToken(event.text);
            body.textContent = (body.textContent ?? '') + event.text;
        } else if (event.kind === 'done') {
            setFinal(event.summary);
            body.textContent = event.summary;
            status.textContent = 'done';
        } else if (event.kind === 'error') {
            status.textContent = `error: ${event.message}`;
        }
    }

    private async saveSummaryToFrontmatter(noteId: string, summary: string): Promise<void> {
        const note = await api.getNote(noteId);
        const nextFrontmatter = {...note.frontmatter, summary};
        await api.writeNote({path: noteId, content: note.content, frontmatter: nextFrontmatter});
        this.opts.onNotesChanged();
    }

    private closeSummarizeModal(overlay: HTMLElement): void {
        if (this.summarizeAbort !== null) {
            this.summarizeAbort.abort();
            this.summarizeAbort = null;
        }
        overlay.remove();
    }

    private renderLinks(): void {
        if (this.active === null) return;

        const backlinks = this.active.backlinks;
        const outgoing = this.active.wikilinks;

        if (backlinks.length === 0 && outgoing.length === 0) return;

        const noteById = new Map(this.notes.map((n) => [n.id, n]));
        const section = el('section', {class: 'viewer-links'});

        if (backlinks.length > 0) {
            section.appendChild(this.renderBacklinks(backlinks, noteById));
        }

        if (outgoing.length > 0) {
            section.appendChild(this.renderOutgoing(outgoing));
        }

        this.viewer.appendChild(section);
    }

    private renderBacklinks(backlinks: readonly string[], lookup: Map<string, NoteSummary>): HTMLElement {
        const block = el('div', {class: 'viewer-links-block'},
            el('h3', {class: 'viewer-links-head'},
                el('span', {text: 'Linked from'}),
                el('span', {class: 'viewer-links-count', text: String(backlinks.length)})
            )
        );

        const list = el('ul', {class: 'viewer-links-list'});

        for (const id of backlinks) {
            const summary = lookup.get(id);
            const title = summary?.title ?? id;

            list.appendChild(el('li', {class: 'viewer-link-row'},
                el('button', {
                    class: 'viewer-link-btn',
                    attrs: {type: 'button', title: id},
                    on: {click: () => void this.openNoteFromWikilink(id)}
                },
                    el('span', {class: 'viewer-link-icon', text: '←'}),
                    el('span', {class: 'viewer-link-title', text: title})
                ),
                el('span', {class: 'viewer-link-path', text: id})
            ));
        }

        block.appendChild(list);
        return block;
    }

    private renderOutgoing(wikilinks: readonly string[]): HTMLElement {
        const resolved: Array<{title: string; noteId: string}> = [];
        const unresolved: string[] = [];

        for (const link of wikilinks) {
            const noteId = this.resolver(link);

            if (noteId !== undefined) {
                resolved.push({title: link, noteId});
            } else {
                unresolved.push(link);
            }
        }

        const block = el('div', {class: 'viewer-links-block'},
            el('h3', {class: 'viewer-links-head'},
                el('span', {text: 'Links to'}),
                el('span', {class: 'viewer-links-count', text: String(wikilinks.length)})
            )
        );

        const list = el('ul', {class: 'viewer-links-list'});

        for (const {title, noteId} of resolved) {
            list.appendChild(el('li', {class: 'viewer-link-row'},
                el('button', {
                    class: 'viewer-link-btn',
                    attrs: {type: 'button', title: noteId},
                    on: {click: () => void this.openNoteFromWikilink(noteId)}
                },
                    el('span', {class: 'viewer-link-icon', text: '→'}),
                    el('span', {class: 'viewer-link-title', text: title})
                ),
                el('span', {class: 'viewer-link-path', text: noteId})
            ));
        }

        for (const title of unresolved) {
            list.appendChild(el('li', {class: 'viewer-link-row unresolved'},
                el('button', {
                    class: 'viewer-link-btn unresolved',
                    attrs: {type: 'button', title: `Create '${title}'`},
                    on: {click: () => void this.createFromWikilink(title)}
                },
                    el('span', {class: 'viewer-link-icon', text: '?'}),
                    el('span', {class: 'viewer-link-title', text: title})
                ),
                el('span', {class: 'viewer-link-path', text: 'unresolved — click to create'})
            ));
        }

        block.appendChild(list);
        return block;
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
            fetchSnippet: this.fetchSnippet,
            searchTitles: (query) => this.searchTitles(query),
            onDirtyChange: () => this.refreshDrafts()
        });

        this.viewer.appendChild(this.currentEditor.element);
        this.updateToc();
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