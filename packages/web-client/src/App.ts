import {resolveNoteRef as resolveNoteRefCore, resolveNoteRefTarget as resolveNoteRefTargetCore, canonicalNoteLink} from '@synaipse/core';
import {ActivityLog} from './ActivityLog.js';
import {api, NoteSummary} from './Api.js';
import {copyCurrentLink, paletteCommands} from './AppCommands.js';
import {CommandPalette} from './CommandPalette.js';
import {clear, el, isAppVisible, isTypingTarget} from './Dom.js';
import {EventStream} from './Events.js';
import type {GraphDelta} from './GraphDelta.js';
import {GraphTab} from './GraphTab.js';
import {ConsentInbox} from './ConsentInbox.js';
import {ImportDialog} from './ImportDialog.js';
import {NotesPanel} from './NotesPanel.js';
import {parseRoute, type Route} from './Router.js';
import {RouteSync} from './RouteSync.js';
import {Search} from './Search.js';
import {openShortcutsDialog} from './Shortcuts.js';
import {getTheme, toggleTheme} from './Theme.js';
import {defineMessages} from './I18n.js';
import {Disposables} from './Disposables.js';
import type {ChatPanel} from './ChatPanel.js';
import type {RoadmapPanel} from './RoadmapPanel.js';
import {isLazyTab, PANEL_FACTORIES, type LazyPanels, type LazyTab, type PanelContext, type PanelView, type Tab} from './Tabs.js';
import {toast} from './Toast.js';
import {Topbar, type TopbarAccount} from './Topbar.js';
import {VaultStore} from './VaultStore.js';

/**
 * The Synaipse app shell (plan P7 / D2): owns the current tab, routes
 * between the views and wires the event stream to them. The pieces live
 * in their own modules: Topbar, Tabs (registry and lazy panels),
 * RouteSync (URL/host route), AppCommands (palette), VaultStore (notes,
 * graph, deltas) and GraphTab (graph view, tag bar, heat, event effects).
 */

const t = defineMessages('app', {
    excerpt: 'Excerpt from {note}',
    noteNotFound: 'No note found for “{ref}”. Link the note by its exact title, an alias or its path (e.g. Memory/project/note.md).'
});

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
    private readonly store = new VaultStore({
        listNotes: () => api.listNotesVersioned(),
        getGraph: () => api.getGraphVersioned()
    });

    private notesPanel: NotesPanel;
    private graphTab: GraphTab;
    private search: Search | null = null;
    private activityLog: ActivityLog;
    private events: EventStream;
    private topbar: Topbar;
    private body: HTMLElement;
    /** Lazily built panels (plan P3 / D1): created on first open. */
    private readonly panels = new Map<LazyTab, Promise<PanelView>>();
    private readonly loadedPanels = new Map<LazyTab, PanelView>();
    private chatInfo: Parameters<ChatPanel['setInfo']> | null = null;
    private consentPanel: ConsentInbox;
    private palette: CommandPalette<NoteSummary>;
    private importDialog: ImportDialog;
    private readonly routes: RouteSync;
    /** The note a `#/graph?focus=` route centred on; kept in the URL while the graph shows. */
    private graphFocus: string | null = null;
    private reloadTimer: number | null = null;
    /** Everything the app starts; released by destroy() (plan P3 / D1). */
    private readonly life = new Disposables();

    public constructor(
        account: TopbarAccount | null = null,
        private readonly appOpts: AppOptions = {}
    ) {
        this.routes = new RouteSync(appOpts, () => this.currentRoute());

        this.notesPanel = new NotesPanel({
            onNotesChanged: () => this.notesChanged(),
            onActiveNoteChange: () => this.routes.record(),
            onAskAboutSelection: (noteId, selection) => {
                void this.panel('chat').then((chat) => {
                    chat.attachContextForQuestion(t('excerpt', {note: noteId}), selection);
                    void this.go({tab: 'chat'});
                });
            }
        });

        this.palette = new CommandPalette<NoteSummary>({
            onSelectNote: (noteId) => this.openNote(noteId),
            commands: () => this.paletteCommands()
        });

        this.importDialog = new ImportDialog({onNotesChanged: () => this.notesChanged()});

        this.consentPanel = new ConsentInbox({
            onCountChange: (count) => this.topbar.setConsentBadge(count),
            onOpenNote: (noteId) => this.openNote(noteId)
        });

        this.graphTab = new GraphTab(this.store, {
            isActive: () => this.tab === 'graph',
            onSelectNote: (noteId) => this.openNote(noteId)
        });

        this.body = el('div', {style: {display: 'contents'}});
        this.topbar = new Topbar({
            initialTab: this.tab,
            account,
            ...(appOpts.onSignedOut !== undefined ? {onSignedOut: appOpts.onSignedOut} : {}),
            onTab: (tab) => void this.go({tab}),
            onPalette: () => this.palette.openPalette(),
            onImport: () => void this.importDialog.open(),
            onActivity: () => this.activityLog.toggle()
        });

        this.activityLog = new ActivityLog({
            resolveTitle: (noteId) => this.store.notes.find((n) => n.id === noteId)?.title,
            onClick: (event) => {
                const target = event.touched[0];

                if (target !== undefined) {
                    this.openNote(target);
                }
            },
            onUnreadChange: (count) => this.topbar.setActivityBadge(count)
        });

        this.events = new EventStream();
        this.events.subscribe((event) => {
            this.activityLog.push(event);
            // Writes no longer trigger a reload here: the server follows up
            // with a `graph-delta` (or `graph-reset`) event, see applyDelta.
            this.graphTab.onEvent(event);
        });
        this.events.subscribeNamed('graph-delta', (data) => this.applyDelta(data as GraphDelta));
        this.events.subscribeNamed('graph-reset', () => this.scheduleVaultReload());
        this.events.onReconnect(() => this.scheduleVaultReload());
        // Only panels that were opened can show stale data.
        this.events.subscribe((event) => this.loadedPanel('roadmap')?.onVaultEvent(event.touched));
        this.events.subscribe((event) => this.loadedPanel('inbox')?.onVaultEvent(event.touched));
        this.events.subscribe((event) => this.loadedPanel('benchmarks')?.onVaultEvent(event.touched));

        this.element = el('div', {class: 'root synaipse-app'}, this.topbar.element, this.body, this.activityLog.element);

        this.showNotes();
    }

    public async mount(host: HTMLElement): Promise<void> {
        host.appendChild(this.element);
        host.appendChild(this.palette.element);
        this.events.start();
        this.consentPanel.start(this.events);
        this.graphTab.start();
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
        this.reloadTimer = null;

        this.events.stop();
        this.consentPanel.stop();
        this.activityLog.destroy();
        this.search?.destroy();
        this.graphTab.destroy();
        this.palette.destroy();
        this.importDialog.close();
        this.topbar.destroy();
        for (const panel of this.loadedPanels.values()) panel.destroy?.();
        this.loadedPanels.clear();
        this.panels.clear();
        this.notesPanel.destroy();
        this.element.remove();
    }

    /** Host tab became visible / hidden (forwarded to the active panel). */
    public onShow(): void {
        if (isLazyTab(this.tab)) void this.loadedPanels.get(this.tab)?.onShow?.();
    }

    public onHide(): void {
        if (isLazyTab(this.tab)) this.loadedPanels.get(this.tab)?.onHide?.();
    }

    /**
     * Go to a route (plan P7 / C1): a hash like `#/notes/a.md`, a tab name,
     * or a note id. From the host (handle.navigate) and from the URL.
     * `replace` updates the history entry instead of adding one.
     */
    public navigate(route: string, opts: {replace?: boolean} = {}): Promise<void> {
        return this.go(parseRoute(route) ?? {tab: 'notes'}, opts.replace === true ? 'replace' : 'push');
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
            openNote: (noteId) => this.openNote(noteId),
            openRef: (ref) => {
                const id = resolveNoteRefCore(ref, this.store.notes);
                if (id === null) {
                    toast(t('noteNotFound', {ref}), {kind: 'error'});
                    return;
                }
                this.openNote(id);
            },
            resolveNoteLink: (ref) => {
                const target = resolveNoteRefTargetCore(ref, this.store.notes);
                return target === null ? null : canonicalNoteLink(target);
            },
            notesChanged: () => this.notesChanged(),
            routeChanged: () => this.routes.record(),
            events: this.events
        };
    }

    private openNote(noteId: string): void {
        void this.go({tab: 'notes', note: noteId});
    }

    /**
     * The one way to change the view. Steps on the way (tab switch, note
     * load) stay out of the history; the view that results is recorded
     * once at the end — also when the user kept unsaved changes and so
     * stayed where they were.
     */
    private async go(route: Route, mode: 'push' | 'replace' = 'push'): Promise<void> {
        this.routes.begin();
        try {
            if (route.tab === 'roadmap' && route.project !== undefined) {
                // Before the tab shows, so its first load picks the project.
                await (await this.panel('roadmap')).selectProject(route.project);
            }
            await this.switchTab(route.tab);
            if (route.tab === 'notes' && route.note !== undefined) await this.notesPanel.openNote(route.note);
            this.graphFocus = route.tab === 'graph' ? route.focus ?? null : null;
            if (this.graphFocus !== null) this.graphTab.focus(this.graphFocus);
        } catch (error) {
            console.error('navigation failed', error);
        } finally {
            this.routes.end();
        }
        // Always settle: the host learns where the app ended up, also when it stayed put.
        this.routes.record(mode, true);
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

    private async withRoadmap(action: (panel: RoadmapPanel) => Promise<void>): Promise<void> {
        await this.go({tab: 'roadmap'});
        await action(await this.panel('roadmap'));
    }

    private paletteCommands(): ReturnType<typeof paletteCommands> {
        const is3d = this.graphTab.prefs.viewMode.get() === '3d';
        const settings = this.topbar.settings;
        return paletteCommands({
            goTab: (tab) => void this.go({tab}),
            isLightTheme: getTheme() === 'light',
            is3d,
            newNote: () => void this.go({tab: 'notes'}).then(() => this.notesPanel.newNote()),
            focusSearch: () => this.search?.focus(),
            openImport: () => void this.importDialog.open(),
            toggleTheme: () => toggleTheme(),
            toggleActivity: () => this.activityLog.toggle(),
            toggleGraphMode: () => {
                this.graphTab.prefs.viewMode.set(is3d ? '2d' : '3d');
                void this.go({tab: 'graph'});
            },
            newRoadmapProject: () => void this.withRoadmap((panel) => panel.newProject()),
            newRoadmapStep: () => void this.withRoadmap((panel) => panel.newStep()),
            ...(this.appOpts.routing === 'hash' ? {copyLink: copyCurrentLink} : {}),
            ...(settings !== null ? {openSettings: () => settings.open()} : {})
        });
    }

    /** `?` opens the shortcut overview, unless the user is typing or a dialog is open. */
    private onShortcutKey(event: KeyboardEvent): void {
        if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
        if (isTypingTarget(event.target) || this.palette.isOpen() || !isAppVisible(this.element)) return;
        if (document.querySelector('body > .synaipse-portal > .modal-backdrop') !== null) return;
        event.preventDefault();
        openShortcutsDialog();
    }

    /** A local write changed notes: refresh the list, refetch the graph when next shown. */
    private notesChanged(): void {
        this.store.dropGraph();
        void this.loadNotes();
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
            this.store.dropGraph();
            return;
        }

        try {
            await this.store.loadGraph();
        } catch (error) {
            console.error('failed to refresh graph', error);
            return;
        }

        this.graphTab.refresh();
    }

    /** Apply a server delta (plan P4 / A5); a version gap falls back to a full reload. */
    private applyDelta(delta: GraphDelta): void {
        const outcome = this.store.applyDelta(delta);

        if (outcome.notesChanged) this.publishNotes();
        if (outcome.graphChanged) this.graphTab.refresh();
        if (outcome.reload) this.scheduleVaultReload();
    }

    private async installSearch(): Promise<void> {
        let semanticEnabled = false;

        try {
            const info = await api.getInfo();
            semanticEnabled = info.semanticEnabled;
            this.store.project = info.project;
            this.notesPanel.setHistoryEnabled(info.historyEnabled);
            this.notesPanel.setChatEnabled(info.chatEnabled);
            this.chatInfo = [info.chatEnabled, info.chatModel, info.chatProvider, info.researchEnabled, info.chatProviderIsLocal];
            this.loadedPanel('chat')?.setInfo(...this.chatInfo);
        } catch {
            // info endpoint failed — degrade silently to fulltext-only mode
        }

        this.search = new Search({
            semanticEnabled,
            onOpenNote: (noteId) => this.openNote(noteId),
            onTopHitChanged: (noteId) => {
                if (noteId !== null) this.graphTab.concentrate(noteId);
            }
        });

        this.topbar.element.appendChild(this.search.element);
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
        this.topbar.setActiveTab(tab);
        this.routes.record();

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

        clear(this.body);
        this.body.appendChild(this.graphTab.element);
        await this.graphTab.show();
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

    private async loadNotes(): Promise<void> {
        try {
            await this.store.loadNotes();
            this.publishNotes();
        } catch (error) {
            console.error('failed to load notes', error);
        }
    }

    private publishNotes(): void {
        this.notesPanel.setNotes(this.store.notes);
        this.palette.setNotes(this.store.notes);
    }

    private showNotes(): void {
        clear(this.body);
        this.body.appendChild(this.notesPanel.element);
    }
}
