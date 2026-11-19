import type {Graph} from '@synaipse/core';
import {resolveNoteRef as resolveNoteRefCore, resolveNoteRefTarget as resolveNoteRefTargetCore, canonicalNoteLink} from '@synaipse/core';
import {ActivityLog} from './ActivityLog.js';
import {api, NoteSummary} from './Api.js';
import {CommandPalette} from './CommandPalette.js';
import {clear, el} from './Dom.js';
import {EventStream, SynaipseEvent} from './Events.js';
import {applyGraphDelta, applyNotesDelta, isEmptyGraphDelta, type GraphDelta} from './GraphDelta.js';
import type {GraphRenderer} from './GraphRenderer.js';
import {bumpedScore, currentHeatMap, type HeatState} from './Heat.js';
import {ConsentInbox} from './ConsentInbox.js';
import {ImportDialog} from './ImportDialog.js';
import logoSvg from './Logo.svg?raw';
import {NotesPanel} from './NotesPanel.js';
import {PersistentValue, setCodec} from './Persistence.js';
import {Search} from './Search.js';
import {Settings} from './Settings.js';
import {TagBar, TagEntry, viewModeCodec, type ViewMode} from './TagBar.js';
import {getTheme, toggleTheme, onThemeChange, type Theme} from './Theme.js';
import {Disposables} from './Disposables.js';
import type {ChatPanel} from './ChatPanel.js';
import {isLazyTab, PANEL_FACTORIES, TAB_DEFS, TABS, type LazyPanels, type LazyTab, type PanelContext, type PanelView, type Tab} from './Tabs.js';

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
        private readonly appOpts: {onSignedOut?: () => void} = {}
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
            onAskAboutSelection: (noteId, selection) => {
                void this.panel('chat').then((chat) => {
                    chat.attachContextForQuestion(`Auszug aus ${noteId}`, selection);
                    void this.switchTab('chat');
                });
            }
        });

        this.palette = new CommandPalette<NoteSummary>({
            onSelectNote: (noteId) => {
                this.notesPanel.openNote(noteId);
                void this.switchTab('notes');
            },
            onSwitchTab: (tab) => void this.switchTab(tab)
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
                this.notesPanel.openNote(noteId);
                void this.switchTab('notes');
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
                    this.notesPanel.openNote(target);
                    void this.switchTab('notes');
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
                this.notesPanel.openNote(noteId);
                void this.switchTab('notes');
            },
            openRef: (ref) => {
                const id = this.resolveNoteRef(ref);
                if (id === null) {
                    window.alert(`Keine Notiz gefunden für „${ref}". Verlinke die Notiz mit ihrem exakten Titel, einem Alias oder ihrem Pfad (z. B. Memory/projekt/notiz.md).`);
                    return;
                }
                this.notesPanel.openNote(id);
                void this.switchTab('notes');
            },
            resolveNoteLink: (ref) => {
                const target = resolveNoteRefTargetCore(ref, this.notes);
                return target === null ? null : canonicalNoteLink(target);
            },
            notesChanged: () => {
                this.graph = null;
                void this.loadNotes();
            }
        };
    }

    /** Route from the host: a tab name, or anything else is opened as a note. */
    public navigate(route: string): void {
        const target = route.replace(/^#?\/?/, '');
        if ((TABS as readonly string[]).includes(target)) {
            void this.switchTab(target as Tab);
            return;
        }
        if (target.length > 0) {
            this.notesPanel.openNote(target);
            void this.switchTab('notes');
        }
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
                this.notesPanel.openNote(noteId);
                void this.switchTab('notes');
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
                on: {click: () => void this.switchTab(def.id)}
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
        for (const [id, btn] of this.tabButtons) {
            btn.classList.toggle('active', id === tab);
        }

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
                this.notesPanel.openNote(noteId);
                void this.switchTab('notes');
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