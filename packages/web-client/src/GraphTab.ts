import {clear, el} from './Dom.js';
import type {SynaipseEvent} from './Events.js';
import {GraphPrefs, viewModeOverride, tagEntries} from './GraphPrefs.js';
import type {GraphRenderer} from './GraphRenderer.js';
import {bumpedScore, currentHeatMap} from './Heat.js';
import {TagBar, type ViewMode} from './TagBar.js';
import type {VaultStore} from './VaultStore.js';

/**
 * The graph tab (plan P7 / D2): picks and mounts the 2D or 3D view, keeps
 * the tag bar in sync with the preferences, applies activity heat and
 * plays MCP events on the graph (pulse, trail, focus).
 */

const HEAT_TICK_MS = 15_000;
/** Two events closer than this draw a trail between their notes. */
const TRAIL_WINDOW_MS = 5000;

export interface GraphTabOptions {
    /** True while the graph tab is the visible one. */
    isActive: () => boolean;
    onSelectNote: (noteId: string) => void;
}

export class GraphTab {
    public readonly element: HTMLElement;
    public readonly prefs = new GraphPrefs();
    private view: GraphRenderer | null = null;
    private tagBar: TagBar | null = null;
    private heatRaf: number | null = null;
    private heatTimer: number | null = null;
    private lastEventNode: {id: string; ts: number} | null = null;

    public constructor(private readonly store: VaultStore, private readonly opts: GraphTabOptions) {
        this.element = el('div', {class: 'graph-wrap'});

        const prefs = this.prefs;
        prefs.onFilterChange(() => {
            if (this.opts.isActive()) this.refresh();
        });
        prefs.viewMode.subscribe(() => {
            if (this.opts.isActive()) {
                void this.render();
                this.renderTagBar();
            }
        });
        prefs.showHeat.subscribe(() => {
            // The views read showHeat from their state, so it has to reach
            // them via update() (refresh also schedules the heat).
            if (this.opts.isActive()) this.refresh();
            else this.scheduleHeat();
        });
    }

    /** Start the periodic heat decay repaint. */
    public start(): void {
        this.heatTimer ??= window.setInterval(() => this.scheduleHeat(), HEAT_TICK_MS);
    }

    public destroy(): void {
        if (this.heatTimer !== null) window.clearInterval(this.heatTimer);
        if (this.heatRaf !== null) cancelAnimationFrame(this.heatRaf);
        this.heatTimer = null;
        this.heatRaf = null;
        this.view?.destroy();
        this.view = null;
        this.prefs.destroy();
    }

    /** Show the tab: fetch the graph on first use, then build the view. */
    public async show(): Promise<void> {
        if (this.store.graph === null) {
            clear(this.element);
            const loadingMsg = el('p', {class: 'loading', text: 'fetching graph…'});
            this.element.appendChild(loadingMsg);

            const started = Date.now();

            try {
                const graph = await this.store.loadGraph();
                loadingMsg.textContent = `fetched ${graph.nodes.length} nodes / ${graph.edges.length} edges in ${Date.now() - started}ms`;
            } catch (error) {
                console.error('failed to load graph', error);
                return;
            }
        }

        await this.render();
    }

    /** Push the current graph and preferences into the view and the tag bar. */
    public refresh(): void {
        this.applyFilter();
        this.renderTagBar();
    }

    /** Centre the view on a note (graph `?focus=` route, MCP event). */
    public focus(noteId: string): void {
        this.view?.focus(noteId);
    }

    /** Search top hit: ripple around the note. */
    public concentrate(noteId: string): void {
        this.view?.concentrate(noteId);
    }

    /** Play an MCP event: pulse the touched notes, trail from the previous one, focus, heat. */
    public onEvent(event: SynaipseEvent): void {
        if (event.touched.length === 0) {
            return;
        }

        const firstId = event.touched[0];

        if (this.view !== null) {
            this.view.pulse(event.touched, event.kind);

            if (firstId !== undefined
                && this.lastEventNode !== null
                && this.lastEventNode.id !== firstId
                && event.ts - this.lastEventNode.ts < TRAIL_WINDOW_MS) {
                this.view.trail(this.lastEventNode.id, firstId, event.kind);
            }

            if (firstId !== undefined) {
                this.view.focus(firstId);
            }
        }

        if (firstId !== undefined) {
            this.lastEventNode = {id: firstId, ts: event.ts};
        }

        this.bumpHeat(event.touched, event.ts);
    }

    private async render(): Promise<void> {
        clear(this.element);

        const graph = this.store.graph;

        if (graph === null) {
            return;
        }

        this.renderTagBar();

        const mode = this.prefs.effectiveViewMode(graph);

        if (this.view !== null) {
            this.view.destroy();
            this.view = null;
        }

        const state = this.prefs.viewState(graph);
        const callbacks = {onSelectNote: this.opts.onSelectNote};

        if (mode === '3d') {
            const {GraphView3D} = await import('./Graph3D.js');
            this.view = new GraphView3D(state, callbacks);
        } else {
            const {GraphView} = await import('./Graph.js');
            this.view = new GraphView(state, callbacks);
        }

        this.element.appendChild(this.view.element);
        this.view.mount();
        this.scheduleHeat();
    }

    private renderTagBar(): void {
        const graph = this.store.graph;

        if (graph === null) {
            return;
        }

        const prefs = this.prefs;
        const callbacks = {
            onToggleTag: (tag: string) => {
                prefs.selectedTags.update((prev) => {
                    const next = new Set(prev);

                    if (next.has(tag)) {
                        next.delete(tag);
                    } else {
                        next.add(tag);
                    }

                    return next;
                });
            },
            onClear: () => prefs.selectedTags.set(new Set()),
            onToggleIsolated: () => prefs.hideIsolated.update((v) => !v),
            onToggleHulls: () => prefs.showHulls.update((v) => !v),
            onToggleHeat: () => prefs.showHeat.update((v) => !v),
            onToggleRoomGrid: () => prefs.showRoomGrid.update((v) => !v),
            onToggleCluster: () => prefs.showCluster.update((v) => !v),
            onToggleCommunities: () => prefs.showCommunities.update((v) => !v),
            onSetViewMode: (mode: ViewMode) => prefs.viewMode.set(mode)
        };

        const state = {
            tags: tagEntries(graph),
            selected: prefs.selectedTags.get(),
            hideIsolated: prefs.hideIsolated.get(),
            showHulls: prefs.showHulls.get(),
            showHeat: prefs.showHeat.get(),
            showRoomGrid: prefs.showRoomGrid.get(),
            showCluster: prefs.showCluster.get(),
            showCommunities: prefs.showCommunities.get(),
            viewMode: prefs.viewMode.get(),
            effectiveViewMode: prefs.effectiveViewMode(graph),
            modeOverride: viewModeOverride(prefs.viewMode.get(), graph.nodes.length),
            project: this.store.project
        };

        if (this.tagBar === null) {
            this.tagBar = new TagBar(state, callbacks);
            this.element.prepend(this.tagBar.element);
            return;
        }

        this.tagBar.update(state);

        if (!this.tagBar.element.isConnected) {
            this.element.prepend(this.tagBar.element);
        }
    }

    private applyFilter(): void {
        if (this.view === null || this.store.graph === null) {
            return;
        }

        this.view.update(this.prefs.viewState(this.store.graph));
        this.scheduleHeat();
    }

    private scheduleHeat(): void {
        if (this.heatRaf !== null) {
            return;
        }

        this.heatRaf = requestAnimationFrame(() => {
            this.heatRaf = null;
            this.view?.applyHeat(currentHeatMap(this.prefs.heatState.get(), Date.now()));
        });
    }

    private bumpHeat(noteIds: readonly string[], ts: number): void {
        if (noteIds.length === 0) {
            return;
        }

        this.prefs.heatState.update((state) => {
            const next = {...state};

            for (const id of noteIds) {
                next[id] = bumpedScore(next[id], ts, 1);
            }

            return next;
        });

        this.scheduleHeat();
    }
}
