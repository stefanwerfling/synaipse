import type {Graph} from '@synaipse/core';
import {resolveNoteRef as resolveNoteRefCore, resolveNoteRefTarget as resolveNoteRefTargetCore, canonicalNoteLink} from '@synaipse/core';
import {ActivityLog} from './ActivityLog.js';
import {api, NoteSummary} from './Api.js';
import {CommandPalette, type PaletteCommand} from './CommandPalette.js';
import {clear, el, isAppVisible, isTypingTarget} from './Dom.js';
import {EventStream, SynaipseEvent} from './Events.js';
import {applyGraphDelta, applyNotesDelta, isEmptyGraphDelta, type GraphDelta} from './GraphDelta.js';
import type {GraphRenderer} from './GraphRenderer.js';
import {bumpedScore, currentHeatMap, type HeatState} from './Heat.js';
import {ConsentInbox} from './ConsentInbox.js';
import {ImportDialog} from './ImportDialog.js';
import logoSvg from './Logo.svg?raw';
import {NotesPanel} from './NotesPanel.js';
import {PersistentValue, setCodec} from './Persistence.js';
import {formatRoute, parseRoute, type Route} from './Router.js';
import {Search} from './Search.js';
import {openShortcutsDialog} from './Shortcuts.js';
import {Settings} from './Settings.js';
import {TagBar, TagEntry, viewModeCodec, type ViewMode} from './TagBar.js';
import {getTheme, toggleTheme, onThemeChange, type Theme} from './Theme.js';
import {Disposables} from './Disposables.js';
import type {ChatPanel} from './ChatPanel.js';
import type {RoadmapPanel} from './RoadmapPanel.js';
import {isLazyTab, PANEL_FACTORIES, TAB_DEFS, type LazyPanels, type LazyTab, type PanelContext, type PanelView, type Tab} from './Tabs.js';
import {toast} from './Toast.js';

const STORAGE_SELECTED_TAGS = 'synaipse.graph.selectedTags';
const STORAGE_HIDE_ISOLATED = 'synaipse.graph.hideIsolated';
const STORAGE_SHOW_HULLS = 'synaipse.graph.showHulls';
const STORAGE_SHOW_HEAT = 'synaipse.graph.showHeat';
const STORAGE_HEAT_STATE = 'synaipse.graph.heatState';
const STORAGE_SHOW_ROOM_GRID = 'synaipse.graph.showRoomGrid';
const STORAGE_SHOW_CLUSTER = 'synaipse.graph.showCluster';
const STORAGE_SHOW_COMMUNITIES = 'synaipse.graph.showCommunities';
const STORAGE_VIEW_MODE = 'synaipse.graph.viewMode';
const EMPTY_TAG_SET: ReadonlySet<string> = new Set();
const HEAT_TICK_MS = 15_000;

// Node-count thresholds for the 3D view (three.js simulates every frame).
// The 2D view scales on its own: from a few thousand notes it switches to
// the server layout with a community overview (see Graph.ts), so only 3D
// is limited: a warning from 5k, from 20k the 2D view is forced.
const HUGE_GRAPH_FORCE_2D = 20_000;
const HUGE_GRAPH_WARN_3D = 5_000;


export interface AppOptions {
    onSignedOut?: () => void;
    /** 'hash': the view lives in location.hash (standalone); 'none': only onRouteChange (embedded). */
    routing?: 'hash' | 'none';
    /** Every view change, as a route like `#/notes/a.md`, for a host that mirrors it. */
    onRouteChange?: (route: string) => void;
}

export class App {
    public readonly element: HTMLElement;
    private tab: Tab = 'notes';
    private notes: NoteSummary[] = [];
    private graph: Graph | null = null;
    /** Server versions behind `notes` / `graph`; null = unknown, next delta re-fetches. */
    private notesVersion: number | null = null;
    private graphVersion: number | null = null;
    private project: string | null = null;

    private notesPanel: NotesPanel;
    private tagBar: TagBar | null = null;
    private graphView: GraphRenderer | null = null;
    private graphViewMode: ViewMode | null = null;
    private search: Search | null = null;
    private activityLog: ActivityLog;
    private events: EventStream;
    private topbar!: HTMLElement;

    private body: HTMLElement;
    private graphWrap: HTMLElement;
    private consentBadge!: HTMLElement;
    private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
    /** Lazily built panels (plan P3 / D1): created on first open. */
    private readonly panels = new Map<LazyTab, Promise<PanelView>>();
    private readonly loadedPanels = new Map<LazyTab, PanelView>();
    private chatInfo: Parameters<ChatPanel['setInfo']> | null = null;
    private consentPanel!: ConsentInbox;
    private palette!: CommandPalette<NoteSummary>;
    private activityBtn!: HTMLButtonElement;
    private activityBadge!: HTMLElement;
    private importDialog!: ImportDialog;
    private themeToggleBtn!: HTMLButtonElement;
    private settings: Settings | null = null;
    /** go() calls in progress; their intermediate steps stay out of the history. */
    private navigating = 0;
    private lastRoute: string | null = null;
    /** The note a `#/graph?focus=` route centred on; kept in the URL while the graph shows. */
    private graphFocus: string | null = null;

    private selectedTags: PersistentValue<ReadonlySet<string>>;
    private hideIsolated: PersistentValue<boolean>;
    private showHulls: PersistentValue<boolean>;
    private showHeat: PersistentValue<boolean>;
    private heatState: PersistentValue<HeatState>;
    private showRoomGrid: PersistentValue<boolean>;
    private showCluster: PersistentValue<boolean>;
    private showCommunities: PersistentValue<boolean>;
    private viewMode: PersistentValue<ViewMode>;
    private heatRaf: number | null = null;
    private reloadTimer: number | null = null;
    /** Everything the app starts; released by destroy() (plan P3 / D1). */
    private readonly life = new Disposables();

    public constructor(
        private readonly account: {id: number; email: string; isAdmin: boolean; managedByHost?: boolean} | null = null,
        private readonly appOpts: AppOptions = {}
    ) {
        this.selectedTags = new PersistentValue<ReadonlySet<string>>(
            STORAGE_SELECTED_TAGS,
            EMPTY_TAG_SET,
            setCodec
        );
        this.hideIsolated = new PersistentValue<boolean>(STORAGE_HIDE_ISOLATED, false);
        this.showHulls = new PersistentValue<boolean>(STORAGE_SHOW_HULLS, false);
        this.showHeat = new PersistentValue<boolean>(STORAGE_SHOW_HEAT, false);
        this.heatState = new PersistentValue<HeatState>(STORAGE_HEAT_STATE, {}, undefined, 500);
        this.showRoomGrid = new PersistentValue<boolean>(STORAGE_SHOW_ROOM_GRID, false);
        this.showCluster = new PersistentValue<boolean>(STORAGE_SHOW_CLUSTER, false);
        this.showCommunities = new PersistentValue<boolean>(STORAGE_SHOW_COMMUNITIES, false);
        this.viewMode = new PersistentValue<ViewMode>(STORAGE_VIEW_MODE, '2d', viewModeCodec);

        this.notesPanel = new NotesPanel({
            onNotesChanged: () => {
                this.graph = null;
                this.loadNotes();
            },
            onActiveNoteChange: () => this.routeChanged(),
            onAskAboutSelection: (noteId, selection) => {
                void this.panel('chat').then((chat) => {
                    chat.attachContextForQuestion(`Auszug aus ${noteId}`, selection);
                    void this.go({tab: 'chat'});
                });
            }
        });

        this.palette = new CommandPalette<NoteSummary>({
            onSelectNote: (noteId) => {
                void this.go({tab: 'notes', note: noteId});
            },
            commands: () => this.paletteCommands()
        });

        this.importDialog = new ImportDialog({
            onNotesChanged: () => {
                this.graph = null;
                void this.loadNotes();
            }
        });

        this.consentPanel = new ConsentInbox({
            onCountChange: (count) => this.setConsentBadge(count),
            onOpenNote: (noteId) => {
                void this.go({tab: 'notes', note: noteId});
            }
        });

        this.body = el('div', {style: {display: 'contents'}});
        this.graphWrap = el('div', {class: 'graph-wrap'});
        this.topbar = this.buildTopbar();

        this.activityLog = new ActivityLog({
            resolveTitle: (noteId) => this.notes.find((n) => n.id === noteId)?.title,
            onClick: (event) => {
                const target = event.touched[0];

                if (target !== undefined) {
                    void this.go({tab: 'notes', note: target});
                }
            },
            onUnreadChange: (count) => this.setActivityBadge(count)
        });

        this.events = new EventStream();
        this.events.subscribe((event) => this.handleMcpEvent(event));
        this.events.subscribeNamed('graph-delta', (data) => this.applyDelta(data as GraphDelta));
        this.events.subscribeNamed('graph-reset', () => this.scheduleVaultReload());
        this.events.onReconnect(() => this.scheduleVaultReload());
        // Only panels that were opened can show stale data.
        this.events.subscribe((event) => this.loadedPanel('roadmap')?.onVaultEvent(event.touched));
        this.events.subscribe((event) => this.loadedPanel('inbox')?.onVaultEvent(event.touched));
        this.events.subscribe((event) => this.loadedPanel('benchmarks')?.onVaultEvent(event.touched));

        this.element = el('div', {class: 'root synaipse-app'}, this.topbar, this.body, this.activityLog.element);

        this.selectedTags.subscribe(() => {
            if (this.tab === 'graph') {
                this.applyGraphFilter();
                this.renderTagBar();
            }
        });

        this.hideIsolated.subscribe(() => {
            if (this.tab === 'graph') {
                this.applyGraphFilter();
                this.renderTagBar();
            }
        });

        this.showHulls.subscribe(() => {
            if (this.tab === 'graph') {
                this.applyGraphFilter();
                this.renderTagBar();
            }
        });

        this.viewMode.subscribe(() => {
            if (this.tab === 'graph') {
                void this.renderGraphTab();
                this.renderTagBar();
            }
        });

        this.showHeat.subscribe(() => {
            // The views read showHeat from their state, so it has to reach
            // them via update() (applyGraphFilter also schedules the heat).
            if (this.tab === 'graph') {
                this.applyGraphFilter();
                this.renderTagBar();
            } else {
                this.scheduleHeatApply();
            }
        });

        this.showRoomGrid.subscribe(() => {
            if (this.tab === 'graph') {
                this.applyGraphFilter();
                this.renderTagBar();
            }
        });

        this.showCommunities.subscribe(() => {
            if (this.tab === 'graph') {
                this.applyGraphFilter();
                this.renderTagBar();
            }
        });

        this.showCluster.subscribe(() => {
            if (this.tab === 'graph') {
                this.applyGraphFilter();
                this.renderTagBar();
            }
        });

        this.showNotes();
    }

    private scheduleHeatApply(): void {
        if (this.heatRaf !== null) {
            return;
        }

        this.heatRaf = requestAnimationFrame(() => {
            this.heatRaf = null;

            if (this.graphView === null) {
                return;
            }

            const map = currentHeatMap(this.heatState.get(), Date.now());
            this.graphView.applyHeat(map);
        });
    }

    private bumpHeat(noteIds: readonly string[], ts: number): void {
        if (noteIds.length === 0) {
            return;
        }

        this.heatState.update((state) => {
            const next = {...state};

            for (const id of noteIds) {
                next[id] = bumpedScore(next[id], ts, 1);
            }

            return next;
        });

        this.scheduleHeatApply();
    }

    public async mount(host: HTMLElement): Promise<void> {
        host.appendChild(this.element);
        host.appendChild(this.palette.element);
        this.events.start();
        this.consentPanel.start();
        this.life.interval(() => this.scheduleHeatApply(), HEAT_TICK_MS);
        this.life.listen(document, 'keydown', (event) => this.onShortcutKey(event));
        if (this.appOpts.routing === 'hash') {
            // Back/Forward and edited URLs; our own pushState fires no hashchange.
            this.life.listen(window, 'hashchange', () => void this.navigate(window.location.hash, {replace: true}));
        }
        await Promise.all([this.loadNotes(), this.installSearch()]);
    }

    /**
     * Tear the app down completely: SSE streams, timers, animation frames,
     * global listeners, panels and DOM. After this the host may mount a
     * fresh App into the same container (plan P3 / E1).
     */
    public destroy(): void {
        this.life.dispose();
        if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
        if (this.heatRaf !== null) cancelAnimationFrame(this.heatRaf);
        this.reloadTimer = null;
        this.heatRaf = null;

        this.events.stop();
        this.consentPanel.stop();
        this.activityLog.destroy();
        this.search?.destroy();
        this.graphView?.destroy();
        this.graphView = null;
        this.palette.destroy();
        this.importDialog.close();
        this.settings?.close();
        for (const panel of this.loadedPanels.values()) panel.destroy?.();
        this.loadedPanels.clear();
        this.panels.clear();
        this.notesPanel.destroy();
        for (const value of [this.selectedTags, this.hideIsolated, this.showHulls, this.showHeat, this.heatState,
            this.showRoomGrid, this.showCluster, this.showCommunities, this.viewMode]) {
            value.destroy();
        }
        this.element.remove();
    }

    /** Host tab became visible / hidden (forwarded to the active panel). */
    public onShow(): void {
        if (isLazyTab(this.tab)) void this.loadedPanels.get(this.tab)?.onShow?.();
    }

    public onHide(): void {
        if (isLazyTab(this.tab)) this.loadedPanels.get(this.tab)?.onHide?.();
    }

    /** The panel behind a lazy tab, built (and its module imported) on first use. */
    private panel<K extends LazyTab>(id: K): Promise<LazyPanels[K]> {
        let pending = this.panels.get(id);
        if (pending === undefined) {
            pending = PANEL_FACTORIES[id](this.panelContext()).then((panel) => {
                if (id === 'chat' && this.chatInfo !== null) {
                    (panel as ChatPanel).setInfo(...this.chatInfo);
                }
                this.loadedPanels.set(id, panel);
                return panel;
            });
            pending.catch(() => this.panels.delete(id));
            this.panels.set(id, pending);
        }
        return pending as Promise<LazyPanels[K]>;
    }

    private loadedPanel<K extends LazyTab>(id: K): LazyPanels[K] | undefined {
        return this.loadedPanels.get(id) as LazyPanels[K] | undefined;
    }

    private panelContext(): PanelContext {
        return {
            openNote: (noteId) => {
                void this.go({tab: 'notes', note: noteId});
            },
            openRef: (ref) => {
                const id = this.resolveNoteRef(ref);
                if (id === null) {
                    toast(`Keine Notiz gefunden für „${ref}". Verlinke die Notiz mit ihrem exakten Titel, einem Alias oder ihrem Pfad (z. B. Memory/projekt/notiz.md).`, {kind: 'error'});
                    return;
                }
                void this.go({tab: 'notes', note: id});
            },
            resolveNoteLink: (ref) => {
                const target = resolveNoteRefTargetCore(ref, this.notes);
                return target === null ? null : canonicalNoteLink(target);
            },
            notesChanged: () => {
                this.graph = null;
                void this.loadNotes();
            },
            routeChanged: () => this.routeChanged()
        };
    }

    /**
     * Go to a route (plan P7 / C1): a hash like `#/notes/a.md`, a tab name,
     * or a note id. From the host (handle.navigate) and from the URL.
     * `replace` updates the history entry instead of adding one.
     */
    public navigate(route: string, opts: {replace?: boolean} = {}): Promise<void> {
        return this.go(parseRoute(route) ?? {tab: 'notes'}, opts.replace === true ? 'replace' : 'push');
    }

    /**
     * The one way to change the view. Steps on the way (tab switch, note
     * load) stay out of the history; the view that results is recorded
     * once at the end — also when the user kept unsaved changes and so
     * stayed where they were.
     */
    private async go(route: Route, mode: 'push' | 'replace' = 'push'): Promise<void> {
        this.navigating += 1;
        try {
            if (route.tab === 'roadmap' && route.project !== undefined) {
                // Before the tab shows, so its first load picks the project.
                await (await this.panel('roadmap')).selectProject(route.project);
            }
            await this.switchTab(route.tab);
            if (route.tab === 'notes' && route.note !== undefined) await this.notesPanel.openNote(route.note);
            this.graphFocus = route.tab === 'graph' ? route.focus ?? null : null;
            if (this.graphFocus !== null) this.graphView?.focus(this.graphFocus);
        } catch (error) {
            console.error('navigation failed', error);
        } finally {
            this.navigating -= 1;
        }
        // Always settle: the host learns where the app ended up, also when it stayed put.
        this.routeChanged(mode, true);
    }

    private currentRoute(): Route {
        const route: Route = {tab: this.tab};
        const note = this.tab === 'notes' ? this.notesPanel.activeNoteId() : null;
        if (note !== null) route.note = note;
        const project = this.tab === 'roadmap' ? this.loadedPanel('roadmap')?.currentProject() ?? null : null;
        if (project !== null) route.project = project;
        if (this.tab === 'graph' && this.graphFocus !== null) route.focus = this.graphFocus;
        return route;
    }

    /**
     * Record the current view: in the URL hash (standalone) and for the
     * host (onRouteChange). Quiet while go() is on its way.
     */
    private routeChanged(mode: 'push' | 'replace' = 'push', settle = false): void {
        if (this.navigating > 0) return;
        const hash = formatRoute(this.currentRoute());
        const changed = hash !== this.lastRoute;
        const first = this.lastRoute === null;
        this.lastRoute = hash;
        // The URL can name another view than the one shown: an edited hash or
        // a host route the user declined (kept unsaved changes). Put it back.
        if (this.appOpts.routing === 'hash' && window.location.hash !== hash) {
            if (first || mode === 'replace' || !changed) window.history.replaceState(window.history.state, '', hash);
            else window.history.pushState(null, '', hash);
        }
        if (changed || settle) this.appOpts.onRouteChange?.(hash);
    }

    private async withRoadmap(action: (panel: RoadmapPanel) => Promise<void>): Promise<void> {
        await this.go({tab: 'roadmap'});
        await action(await this.panel('roadmap'));
    }

    /** What the command palette offers besides notes (plan P7 / C1). */
    private paletteCommands(): PaletteCommand[] {
        const commands: PaletteCommand[] = TAB_DEFS.map((def) => ({
            id: `tab:${def.id}`,
            label: `Go to ${def.label}`,
            hint: 'tab',
            keywords: [def.id, ...(def.title !== undefined ? [def.title] : [])],
            run: () => void this.go({tab: def.id})
        }));
        const isLight = getTheme() === 'light';
        const is3d = this.viewMode.get() === '3d';
        commands.push(
            {
                id: 'note:new', label: 'New note', hint: 'note', keywords: ['create', 'neu', 'notiz'],
                run: () => void this.go({tab: 'notes'}).then(() => this.notesPanel.newNote())
            },
            {
                id: 'search', label: 'Search notes (full text / semantic)', hint: '/', keywords: ['find', 'suche'],
                run: () => this.search?.focus()
            },
            {id: 'import', label: 'Import ChatGPT export', hint: 'import', keywords: ['zip', 'chatgpt'], run: () => void this.importDialog.open()},
            {
                id: 'theme', label: isLight ? 'Switch to dark theme' : 'Switch to light theme', hint: 'theme',
                keywords: ['dark', 'light', 'dunkel', 'hell'], run: () => toggleTheme()
            },
            {id: 'activity', label: 'Toggle activity log', hint: 'panel', keywords: ['events', 'mcp'], run: () => this.activityLog.toggle()},
            {
                id: 'graph:mode', label: is3d ? 'Graph: switch to 2D' : 'Graph: switch to 3D', hint: 'graph', keywords: ['2d', '3d', 'view'],
                run: () => {
                    this.viewMode.set(is3d ? '2d' : '3d');
                    void this.go({tab: 'graph'});
                }
            },
            {
                id: 'roadmap:project', label: 'Roadmap: new project', hint: 'roadmap', keywords: ['projekt', 'create'],
                run: () => void this.withRoadmap((panel) => panel.newProject())
            },
            {
                id: 'roadmap:step', label: 'Roadmap: new step', hint: 'roadmap', keywords: ['schritt', 'create'],
                run: () => void this.withRoadmap((panel) => panel.newStep())
            },
            {id: 'shortcuts', label: 'Keyboard shortcuts', hint: '?', keywords: ['help', 'keys', 'hilfe', 'tasten'], run: () => openShortcutsDialog()}
        );
        if (this.appOpts.routing === 'hash') {
            commands.push({
                id: 'link', label: 'Copy link to this view', hint: 'link', keywords: ['share', 'url', 'teilen'],
                run: () => {
                    void navigator.clipboard.writeText(window.location.href).then(
                        () => toast('Link copied', {kind: 'success'}),
                        () => toast(window.location.href, {durationMs: 0})
                    );
                }
            });
        }
        if (this.settings !== null) {
            commands.push({id: 'settings', label: 'Account settings', hint: 'account', keywords: ['token', 'sign out'], run: () => this.settings?.open()});
        }
        return commands;
    }

    /** `?` opens the shortcut overview, unless the user is typing or a dialog is open. */
    private onShortcutKey(event: KeyboardEvent): void {
        if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
        if (isTypingTarget(event.target) || this.palette.isOpen() || !isAppVisible(this.element)) return;
        if (document.querySelector('body > .synaipse-portal > .modal-backdrop') !== null) return;
        event.preventDefault();
        openShortcutsDialog();
    }

    private lastEventNode: {id: string; ts: number} | null = null;
    private readonly trailWindowMs = 5000;

    private handleMcpEvent(event: SynaipseEvent): void {
        this.activityLog.push(event);

        // Writes no longer trigger a reload here: the server follows up
        // with a `graph-delta` (or `graph-reset`) event, see applyDelta.

        if (event.touched.length === 0) {
            return;
        }

        const firstId = event.touched[0];

        if (this.graphView !== null) {
            this.graphView.pulse(event.touched, event.kind);

            if (firstId !== undefined
                && this.lastEventNode !== null
                && this.lastEventNode.id !== firstId
                && event.ts - this.lastEventNode.ts < this.trailWindowMs) {
                this.graphView.trail(this.lastEventNode.id, firstId, event.kind);
            }

            if (firstId !== undefined) {
                this.graphView.focus(firstId);
            }
        }

        if (firstId !== undefined) {
            this.lastEventNode = {id: firstId, ts: event.ts};
        }

        this.bumpHeat(event.touched, event.ts);
    }

    private scheduleVaultReload(): void {
        // Trailing-edge debounce: each event resets the timer, so a burst of
        // MCP writes collapses to a single reload instead of one every 250ms.
        if (this.reloadTimer !== null) {
            window.clearTimeout(this.reloadTimer);
        }

        this.reloadTimer = window.setTimeout(() => {
            this.reloadTimer = null;
            void this.reloadVault();
        }, 500);
    }

    private async reloadVault(): Promise<void> {
        await this.loadNotes();

        if (this.tab !== 'graph') {
            this.graph = null;
            this.graphVersion = null;
            return;
        }

        try {
            const {data, version} = await api.getGraphVersioned();
            this.graph = data;
            this.graphVersion = version;
        } catch (error) {
            console.error('failed to refresh graph', error);
            return;
        }

        this.applyGraphFilter();
        this.renderTagBar();
    }

    /**
     * Apply a server delta to the note list and, when loaded, the graph
     * (plan P4 / A5). A version gap (missed events, a fetch that raced a
     * write) falls back to a full reload.
     */
    private applyDelta(delta: GraphDelta): void {
        if (this.notesVersion !== delta.from) {
            this.scheduleVaultReload();
            return;
        }

        this.notes = applyNotesDelta(this.notes, delta);
        this.notesVersion = delta.to;
        if (delta.notes.upsert.length > 0 || delta.notes.removed.length > 0) {
            this.notesPanel.setNotes(this.notes);
            this.palette.setNotes(this.notes);
        }

        if (this.graph === null) return;

        if (this.graphVersion !== delta.from) {
            this.scheduleVaultReload();
            return;
        }

        this.graphVersion = delta.to;
        if (isEmptyGraphDelta(delta)) return;

        this.graph = applyGraphDelta(this.graph, delta);
        this.applyGraphFilter();
        this.renderTagBar();
    }

    private async installSearch(): Promise<void> {
        let semanticEnabled = false;

        try {
            const info = await api.getInfo();
            semanticEnabled = info.semanticEnabled;
            this.project = info.project;
            this.notesPanel.setHistoryEnabled(info.historyEnabled);
            this.notesPanel.setChatEnabled(info.chatEnabled);
            this.chatInfo = [info.chatEnabled, info.chatModel, info.chatProvider, info.researchEnabled, info.chatProviderIsLocal];
            this.loadedPanel('chat')?.setInfo(...this.chatInfo);
        } catch {
            // info endpoint failed — degrade silently to fulltext-only mode
        }

        this.search = new Search({
            semanticEnabled,
            onOpenNote: (noteId) => {
                void this.go({tab: 'notes', note: noteId});
            },
            onTopHitChanged: (noteId) => {
                if (noteId !== null && this.graphView !== null) {
                    this.graphView.concentrate(noteId);
                }
            }
        });

        this.topbar.appendChild(this.search.element);
    }

    private buildTopbar(): HTMLElement {
        this.consentBadge = el('span', {class: 'tab-badge', style: {display: 'none'}, text: '0'});
        for (const def of TAB_DEFS) {
            const btn = el('button', {
                class: def.id === this.tab ? 'tab active' : 'tab',
                attrs: {type: 'button', ...(def.title !== undefined ? {title: def.title} : {})},
                on: {click: () => void this.go({tab: def.id})}
            }, el('span', {text: def.label})) as HTMLButtonElement;
            if (def.id === 'consent') btn.appendChild(this.consentBadge);
            this.tabButtons.set(def.id, btn);
        }

        const brand = el('div', {class: 'brand'});
        const logo = el('span', {class: 'brand-logo'});
        logo.innerHTML = logoSvg;
        brand.appendChild(logo);
        brand.appendChild(el('span', {class: 'brand-text', text: 'Synaipse'}));

        this.activityBadge = el('span', {class: 'activity-btn-badge', style: {display: 'none'}, text: '0'});
        this.activityBtn = el('button', {
            class: 'activity-btn',
            attrs: {type: 'button', title: 'Activity log', 'aria-label': 'Toggle activity log'},
            on: {click: () => this.activityLog.toggle()}
        },
            el('span', {class: 'activity-btn-icon', text: '●'}),
            el('span', {class: 'activity-btn-label', text: 'Activity'}),
            this.activityBadge
        ) as HTMLButtonElement;

        const paletteBtn = el('button', {
            class: 'palette-trigger',
            attrs: {type: 'button', title: 'Open command palette (Ctrl/Cmd+K)'},
            on: {click: () => this.palette.openPalette()}
        },
            el('span', {text: 'Search'}),
            el('kbd', {text: '⌘K'})
        );

        const importBtn = el('button', {
            class: 'topbar-import',
            attrs: {type: 'button', title: 'Import notes from external source'},
            text: 'Import',
            on: {click: () => void this.importDialog.open()}
        });

        this.themeToggleBtn = el('button', {
            class: 'theme-toggle',
            attrs: {type: 'button'},
            on: {click: () => toggleTheme()}
        }) as HTMLButtonElement;
        this.updateThemeToggle(getTheme());
        this.life.add(onThemeChange((theme) => this.updateThemeToggle(theme)));

        const trailing: HTMLElement[] = [importBtn, this.themeToggleBtn, this.activityBtn];

        if (this.account !== null) {
            const account = this.account;
            this.settings = new Settings({
                account,
                ...(this.appOpts.onSignedOut !== undefined ? {onSignedOut: this.appOpts.onSignedOut} : {})
            });
            const accountBtn = el('button', {
                class: 'topbar-account',
                attrs: {type: 'button', title: `Signed in as ${account.email} — open account settings`},
                text: account.email,
                on: {click: () => this.settings?.open()}
            });
            trailing.push(accountBtn);
        }

        return el('header', {class: 'topbar'},
            brand,
            el('nav', {class: 'tabs'}, ...this.tabButtons.values()),
            paletteBtn,
            el('div', {class: 'topbar-spacer'}),
            ...trailing
        );
    }

    private updateThemeToggle(theme: Theme): void {
        const isLight = theme === 'light';

        this.themeToggleBtn.textContent = isLight ? '☾' : '☀';
        this.themeToggleBtn.title = isLight ? 'Switch to dark theme' : 'Switch to light theme';
        this.themeToggleBtn.setAttribute('aria-label', this.themeToggleBtn.title);
    }

    private setActivityBadge(count: number): void {
        if (count > 0) {
            this.activityBadge.style.display = '';
            this.activityBadge.textContent = count > 9 ? '9+' : String(count);
            this.activityBtn.classList.add('has-unread');
        } else {
            this.activityBadge.style.display = 'none';
            this.activityBtn.classList.remove('has-unread');
        }
    }

    private setConsentBadge(count: number): void {
        if (count > 0) {
            this.consentBadge.style.display = '';
            this.consentBadge.textContent = count > 9 ? '9+' : String(count);
            this.tabButtons.get('consent')?.classList.add('has-unread');
        } else {
            this.consentBadge.style.display = 'none';
            this.tabButtons.get('consent')?.classList.remove('has-unread');
        }
    }

    private async switchTab(tab: Tab): Promise<void> {
        if (this.tab === tab) {
            return;
        }

        // Lifecycle: tell the panel we're leaving so it can snapshot
        // any state that won't survive a DOM detach (chat: scroll pos).
        if (isLazyTab(this.tab)) {
            this.loadedPanels.get(this.tab)?.onHide?.();
        }

        this.tab = tab;
        if (tab !== 'graph') this.graphFocus = null;
        for (const [id, btn] of this.tabButtons) {
            btn.classList.toggle('active', id === tab);
            if (id === tab) btn.setAttribute('aria-current', 'page');
            else btn.removeAttribute('aria-current');
        }
        this.routeChanged();

        if (tab === 'notes') {
            this.showNotes();
            return;
        }

        if (tab === 'consent') {
            void this.showConsent();
            return;
        }

        if (isLazyTab(tab)) {
            await this.showPanel(tab);
            return;
        }

        await this.showGraph();
    }

    private async showPanel(id: LazyTab): Promise<void> {
        let panel: PanelView;
        try {
            panel = await this.panel(id);
        } catch (error) {
            console.error(`failed to load the ${id} panel`, error);
            return;
        }
        // The user may have switched on while the module was loading.
        if (this.tab !== id) return;
        clear(this.body);
        this.body.appendChild(panel.element);
        await panel.onShow?.();
        if (id === 'chat') (panel as ChatPanel).focusInput();
    }

    private async showConsent(): Promise<void> {
        clear(this.body);
        this.body.appendChild(this.consentPanel.element);
        await this.consentPanel.onShow();
    }

    /**
     * Resolve a roadmap note-link string — which may be a full note id/path, a
     * path missing its `.md` suffix, or a note title/alias — to a concrete note
     * id. Returns null when nothing matches. Mirrors wikilink resolution so a
     * step linked by `[[Title]]` opens the same note the graph/backlinks use.
     */
    private resolveNoteRef(ref: string): string | null {
        return resolveNoteRefCore(ref, this.notes);
    }

    private async loadNotes(): Promise<void> {
        try {
            const {data, version} = await api.listNotesVersioned();
            this.notes = data;
            this.notesVersion = version;
            this.notesPanel.setNotes(this.notes);
            this.palette.setNotes(this.notes);
        } catch (error) {
            console.error('failed to load notes', error);
        }
    }

    private showNotes(): void {
        clear(this.body);
        this.body.appendChild(this.notesPanel.element);
    }

    private async showGraph(): Promise<void> {
        clear(this.body);
        this.body.appendChild(this.graphWrap);

        if (this.graph === null) {
            clear(this.graphWrap);
            const loadingMsg = el('p', {class: 'loading', text: 'fetching graph…'});
            this.graphWrap.appendChild(loadingMsg);

            const started = Date.now();

            try {
                const {data, version} = await api.getGraphVersioned();
                this.graph = data;
                this.graphVersion = version;
                loadingMsg.textContent = `fetched ${this.graph.nodes.length} nodes / ${this.graph.edges.length} edges in ${Date.now() - started}ms`;
            } catch (error) {
                console.error('failed to load graph', error);
                return;
            }
        }

        await this.renderGraphTab();
    }

    private async renderGraphTab(): Promise<void> {
        clear(this.graphWrap);

        if (this.graph === null) {
            return;
        }

        this.renderTagBar();

        const effectiveMode = this.effectiveViewMode();

        if (this.graphView !== null) {
            this.graphView.destroy();
            this.graphView = null;
        }

        const state = {
            data: this.graph,
            selectedTags: this.selectedTags.get(),
            hideIsolated: this.hideIsolated.get(),
            showHulls: this.showHulls.get(),
            showHeat: this.showHeat.get(),
            showRoomGrid: this.showRoomGrid.get(),
            showCluster: this.showCluster.get(),
            showCommunities: this.showCommunities.get()
        };

        const callbacks = {
            onSelectNote: (noteId: string) => {
                void this.go({tab: 'notes', note: noteId});
            }
        };

        if (effectiveMode === '3d') {
            const {GraphView3D} = await import('./Graph3D.js');
            this.graphView = new GraphView3D(state, callbacks);
        } else {
            const {GraphView} = await import('./Graph.js');
            this.graphView = new GraphView(state, callbacks);
        }

        this.graphViewMode = effectiveMode;
        this.graphWrap.appendChild(this.graphView.element);
        this.graphView.mount();
        this.scheduleHeatApply();
    }

    private renderTagBar(): void {
        if (this.graph === null) {
            return;
        }

        const entries = this.computeTagEntries();

        const callbacks = {
            onToggleTag: (tag: string) => {
                this.selectedTags.update((prev) => {
                    const next = new Set(prev);

                    if (next.has(tag)) {
                        next.delete(tag);
                    } else {
                        next.add(tag);
                    }

                    return next;
                });
            },
            onClear: () => this.selectedTags.set(new Set()),
            onToggleIsolated: () => this.hideIsolated.update((v) => !v),
            onToggleHulls: () => this.showHulls.update((v) => !v),
            onToggleHeat: () => this.showHeat.update((v) => !v),
            onToggleRoomGrid: () => this.showRoomGrid.update((v) => !v),
            onToggleCluster: () => this.showCluster.update((v) => !v),
            onToggleCommunities: () => this.showCommunities.update((v) => !v),
            onSetViewMode: (mode: ViewMode) => this.viewMode.set(mode)
        };

        const state = {
            tags: entries,
            selected: this.selectedTags.get(),
            hideIsolated: this.hideIsolated.get(),
            showHulls: this.showHulls.get(),
            showHeat: this.showHeat.get(),
            showRoomGrid: this.showRoomGrid.get(),
            showCluster: this.showCluster.get(),
            showCommunities: this.showCommunities.get(),
            viewMode: this.viewMode.get(),
            effectiveViewMode: this.effectiveViewMode(),
            modeOverride: this.viewModeOverrideReason(),
            project: this.project
        };

        if (this.tagBar === null) {
            this.tagBar = new TagBar(state, callbacks);
            this.graphWrap.prepend(this.tagBar.element);
            return;
        }

        this.tagBar.update(state);

        if (!this.tagBar.element.isConnected) {
            this.graphWrap.prepend(this.tagBar.element);
        }
    }

    /**
     * Effective render mode = user preference clamped to what the current
     * graph size can actually support. Past 20k nodes 3D is replaced by
     * 2D (server layout + community overview), see the thresholds above.
     */
    private effectiveViewMode(): ViewMode {
        const requested = this.viewMode.get();
        const nodeCount = this.graph?.nodes.length ?? 0;

        if (nodeCount >= HUGE_GRAPH_FORCE_2D && requested === '3d') {
            return '2d';
        }

        return requested;
    }

    private viewModeOverrideReason(): {kind: 'forced' | 'warned'; nodeCount: number} | null {
        const nodeCount = this.graph?.nodes.length ?? 0;

        if (nodeCount >= HUGE_GRAPH_FORCE_2D) {
            return {kind: 'forced', nodeCount};
        }

        if (nodeCount >= HUGE_GRAPH_WARN_3D && this.viewMode.get() === '3d') {
            return {kind: 'warned', nodeCount};
        }

        return null;
    }

    private applyGraphFilter(): void {
        if (this.graphView === null || this.graph === null) {
            return;
        }

        this.graphView.update({
            data: this.graph,
            selectedTags: this.selectedTags.get(),
            hideIsolated: this.hideIsolated.get(),
            showHulls: this.showHulls.get(),
            showHeat: this.showHeat.get(),
            showRoomGrid: this.showRoomGrid.get(),
            showCluster: this.showCluster.get(),
            showCommunities: this.showCommunities.get()
        });
        this.scheduleHeatApply();
    }

    private computeTagEntries(): TagEntry[] {
        if (this.graph === null) {
            return [];
        }

        const counts = new Map<string, number>();
        for (const node of this.graph.nodes) {
            for (const t of node.tags) {
                counts.set(t, (counts.get(t) ?? 0) + 1);
            }
        }

        return [...counts.entries()]
            .map(([tag, count]) => ({tag, count}))
            .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    }
}