import type {Graph} from '@synaipse/core';
import {ActivityLog} from './ActivityLog.js';
import {api, NoteSummary} from './Api.js';
import {ChatPanel} from './ChatPanel.js';
import {CommandPalette} from './CommandPalette.js';
import {clear, el} from './Dom.js';
import {EventStream, SynaipseEvent} from './Events.js';
import type {GraphRenderer} from './GraphRenderer.js';
import {bumpedScore, currentHeatMap, type HeatState} from './Heat.js';
import {ActivityPanel} from './ActivityPanel.js';
import {ImportDialog} from './ImportDialog.js';
import {JobsPanel} from './JobsPanel.js';
import logoSvg from './Logo.svg?raw';
import {NotesPanel} from './NotesPanel.js';
import {PersistentValue, setCodec} from './Persistence.js';
import {Search} from './Search.js';
import {TagBar, TagEntry} from './TagBar.js';

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

type Tab = 'notes' | 'graph' | 'chat' | 'jobs' | 'activity';

export class App {
    public readonly element: HTMLElement;
    private tab: Tab = 'notes';
    private notes: NoteSummary[] = [];
    private graph: Graph | null = null;
    private project: string | null = null;

    private notesPanel: NotesPanel;
    private tagBar: TagBar | null = null;
    private graphView: GraphRenderer | null = null;
    private graphViewMode: '2d' | '3d' | 'atlas' | null = null;
    private search: Search | null = null;
    private activityLog: ActivityLog;
    private events: EventStream;
    private topbar!: HTMLElement;

    private body: HTMLElement;
    private graphWrap: HTMLElement;
    private notesTabBtn!: HTMLButtonElement;
    private graphTabBtn!: HTMLButtonElement;
    private chatTabBtn!: HTMLButtonElement;
    private jobsTabBtn!: HTMLButtonElement;
    private activityTabBtn!: HTMLButtonElement;
    private chatPanel!: ChatPanel;
    private jobsPanel!: JobsPanel;
    private activityPanel!: ActivityPanel;
    private palette!: CommandPalette<NoteSummary>;
    private activityBtn!: HTMLButtonElement;
    private activityBadge!: HTMLElement;
    private importDialog!: ImportDialog;

    private selectedTags: PersistentValue<ReadonlySet<string>>;
    private hideIsolated: PersistentValue<boolean>;
    private showHulls: PersistentValue<boolean>;
    private showHeat: PersistentValue<boolean>;
    private heatState: PersistentValue<HeatState>;
    private showRoomGrid: PersistentValue<boolean>;
    private showCluster: PersistentValue<boolean>;
    private showCommunities: PersistentValue<boolean>;
    private viewMode: PersistentValue<'2d' | '3d' | 'atlas'>;
    private heatTickTimer: number | null = null;
    private heatRaf: number | null = null;
    private reloadTimer: number | null = null;

    public constructor() {
        this.selectedTags = new PersistentValue<ReadonlySet<string>>(
            STORAGE_SELECTED_TAGS,
            EMPTY_TAG_SET,
            setCodec
        );
        this.hideIsolated = new PersistentValue<boolean>(STORAGE_HIDE_ISOLATED, false);
        this.showHulls = new PersistentValue<boolean>(STORAGE_SHOW_HULLS, false);
        this.showHeat = new PersistentValue<boolean>(STORAGE_SHOW_HEAT, false);
        this.heatState = new PersistentValue<HeatState>(STORAGE_HEAT_STATE, {});
        this.showRoomGrid = new PersistentValue<boolean>(STORAGE_SHOW_ROOM_GRID, false);
        this.showCluster = new PersistentValue<boolean>(STORAGE_SHOW_CLUSTER, false);
        this.showCommunities = new PersistentValue<boolean>(STORAGE_SHOW_COMMUNITIES, false);
        this.viewMode = new PersistentValue<'2d' | '3d' | 'atlas'>(STORAGE_VIEW_MODE, '2d');

        this.notesPanel = new NotesPanel({
            onNotesChanged: () => {
                this.graph = null;
                this.loadNotes();
            },
            onAskAboutSelection: (noteId, selection) => {
                this.chatPanel.setStickyContext(`Auszug aus ${noteId}`, selection);
                void this.switchTab('chat');
            }
        });

        this.chatPanel = new ChatPanel({
            onOpenNote: (noteId) => {
                // Research results put the URL into noteId — open it externally.
                if (noteId.startsWith('http://') || noteId.startsWith('https://')) {
                    window.open(noteId, '_blank', 'noopener,noreferrer');
                    return;
                }

                this.notesPanel.openNote(noteId);
                void this.switchTab('notes');
            },
            onSaveAsNote: async (markdown) => {
                const now = new Date();
                const date = now.toISOString().slice(0, 10);
                const time = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
                const path = `chats/${date}-${time}.md`;

                try {
                    const note = await api.writeNote({
                        path,
                        content: markdown,
                        frontmatter: {
                            title: `Chat ${date} ${time}`,
                            tags: ['chat'],
                            type: 'note'
                        }
                    });
                    this.graph = null;
                    void this.loadNotes();
                    return {noteId: note.id};
                } catch (cause) {
                    console.error('save chat as note failed', cause);
                    return null;
                }
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

        this.jobsPanel = new JobsPanel({
            onChange: () => {
                this.graph = null;
                void this.loadNotes();
            }
        });

        this.activityPanel = new ActivityPanel({
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

        this.element = el('div', {class: 'root'}, this.topbar, this.body, this.activityLog.element);

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
            this.scheduleHeatApply();

            if (this.tab === 'graph') {
                this.renderTagBar();
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
        this.heatTickTimer = window.setInterval(() => this.scheduleHeatApply(), HEAT_TICK_MS);
        await Promise.all([this.loadNotes(), this.installSearch()]);
    }

    private lastEventNode: {id: string; ts: number} | null = null;
    private readonly trailWindowMs = 5000;

    private handleMcpEvent(event: SynaipseEvent): void {
        this.activityLog.push(event);

        if (event.kind === 'write' || event.kind === 'delete') {
            this.scheduleVaultReload();
        }

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
        if (this.reloadTimer !== null) {
            return;
        }

        this.reloadTimer = window.setTimeout(() => {
            this.reloadTimer = null;
            void this.reloadVault();
        }, 250);
    }

    private async reloadVault(): Promise<void> {
        await this.loadNotes();

        if (this.tab !== 'graph') {
            this.graph = null;
            return;
        }

        try {
            this.graph = await api.getGraph();
        } catch (error) {
            console.error('failed to refresh graph', error);
            return;
        }

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
            this.chatPanel.setInfo(info.chatEnabled, info.chatModel, info.chatProvider, info.researchEnabled);
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
        this.notesTabBtn = el('button', {
            class: 'tab active',
            attrs: {type: 'button'},
            text: 'Notes',
            on: {click: () => void this.switchTab('notes')}
        }) as HTMLButtonElement;

        this.graphTabBtn = el('button', {
            class: 'tab',
            attrs: {type: 'button'},
            text: 'Graph',
            on: {click: () => void this.switchTab('graph')}
        }) as HTMLButtonElement;

        this.chatTabBtn = el('button', {
            class: 'tab',
            attrs: {type: 'button'},
            text: 'Chat',
            on: {click: () => void this.switchTab('chat')}
        }) as HTMLButtonElement;

        this.jobsTabBtn = el('button', {
            class: 'tab',
            attrs: {type: 'button'},
            text: 'Jobs',
            on: {click: () => void this.switchTab('jobs')}
        }) as HTMLButtonElement;

        this.activityTabBtn = el('button', {
            class: 'tab',
            attrs: {type: 'button'},
            text: 'Activity',
            on: {click: () => void this.switchTab('activity')}
        }) as HTMLButtonElement;

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

        return el('header', {class: 'topbar'},
            brand,
            el('nav', {class: 'tabs'}, this.notesTabBtn, this.graphTabBtn, this.chatTabBtn, this.jobsTabBtn, this.activityTabBtn),
            paletteBtn,
            el('div', {class: 'topbar-spacer'}),
            importBtn,
            this.activityBtn
        );
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

    private async switchTab(tab: Tab): Promise<void> {
        if (this.tab === tab) {
            return;
        }

        this.tab = tab;
        this.notesTabBtn.className = tab === 'notes' ? 'tab active' : 'tab';
        this.graphTabBtn.className = tab === 'graph' ? 'tab active' : 'tab';
        this.chatTabBtn.className = tab === 'chat' ? 'tab active' : 'tab';
        this.jobsTabBtn.className = tab === 'jobs' ? 'tab active' : 'tab';
        this.activityTabBtn.className = tab === 'activity' ? 'tab active' : 'tab';

        if (tab === 'notes') {
            this.showNotes();
            return;
        }

        if (tab === 'chat') {
            this.showChat();
            return;
        }

        if (tab === 'jobs') {
            void this.showJobs();
            return;
        }

        if (tab === 'activity') {
            void this.showActivity();
            return;
        }

        await this.showGraph();
    }

    private async showActivity(): Promise<void> {
        clear(this.body);
        this.body.appendChild(this.activityPanel.element);
        await this.activityPanel.onShow();
    }

    private showChat(): void {
        clear(this.body);
        this.body.appendChild(this.chatPanel.element);
        this.chatPanel.focusInput();
    }

    private async showJobs(): Promise<void> {
        clear(this.body);
        this.body.appendChild(this.jobsPanel.element);
        await this.jobsPanel.onShow();
    }

    private async loadNotes(): Promise<void> {
        try {
            this.notes = await api.listNotes();
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
            this.graphWrap.appendChild(el('p', {class: 'loading', text: 'loading graph…'}));

            try {
                this.graph = await api.getGraph();
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

        const wantMode = this.viewMode.get();

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

        if (wantMode === '3d') {
            const {GraphView3D} = await import('./Graph3D.js');
            this.graphView = new GraphView3D(state, callbacks);
        } else if (wantMode === 'atlas') {
            const {GraphAtlasView} = await import('./GraphAtlas.js');
            this.graphView = new GraphAtlasView(state, callbacks);
        } else {
            const {GraphView} = await import('./Graph.js');
            this.graphView = new GraphView(state, callbacks);
        }

        this.graphViewMode = wantMode;
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
            onSetViewMode: (mode: '2d' | '3d' | 'atlas') => this.viewMode.set(mode)
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