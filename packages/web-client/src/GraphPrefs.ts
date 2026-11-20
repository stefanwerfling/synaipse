import type {Graph} from '@synaipse/core';
import type {GraphRendererState} from './GraphRenderer.js';
import type {HeatState} from './Heat.js';
import {PersistentValue, setCodec} from './Persistence.js';
import {viewModeCodec, type TagEntry, type ViewMode} from './TagBar.js';

/**
 * Persisted graph-tab preferences (plan P7 / D2): tag filter, view
 * toggles, render mode and the activity heat, plus the pure rules that
 * derive the effective mode and the tag list from them.
 */

const EMPTY_TAG_SET: ReadonlySet<string> = new Set();

// Node-count thresholds for the 3D view (three.js simulates every frame).
// The 2D view scales on its own: from a few thousand notes it switches to
// the server layout with a community overview (see Graph.ts), so only 3D
// is limited: a warning from 5k, from 20k the 2D view is forced.
export const HUGE_GRAPH_FORCE_2D = 20_000;
export const HUGE_GRAPH_WARN_3D = 5_000;

export type ViewModeOverride = {kind: 'forced' | 'warned'; nodeCount: number} | null;

/** User preference clamped to what the graph size supports: past 20k nodes 3D becomes 2D. */
export const effectiveViewMode = (requested: ViewMode, nodeCount: number): ViewMode =>
    (nodeCount >= HUGE_GRAPH_FORCE_2D && requested === '3d' ? '2d' : requested);

/** Why the tag bar should flag the mode switch: forced 2D, or a 3D size warning. */
export const viewModeOverride = (requested: ViewMode, nodeCount: number): ViewModeOverride => {
    if (nodeCount >= HUGE_GRAPH_FORCE_2D) {
        return {kind: 'forced', nodeCount};
    }

    if (nodeCount >= HUGE_GRAPH_WARN_3D && requested === '3d') {
        return {kind: 'warned', nodeCount};
    }

    return null;
};

/** Tags with their node counts, most used first, ties alphabetical. */
export const tagEntries = (graph: Graph): TagEntry[] => {
    const counts = new Map<string, number>();
    for (const node of graph.nodes) {
        for (const t of node.tags) {
            counts.set(t, (counts.get(t) ?? 0) + 1);
        }
    }

    return [...counts.entries()]
        .map(([tag, count]) => ({tag, count}))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
};

export class GraphPrefs {
    public readonly selectedTags = new PersistentValue<ReadonlySet<string>>('synaipse.graph.selectedTags', EMPTY_TAG_SET, setCodec);
    public readonly hideIsolated = new PersistentValue<boolean>('synaipse.graph.hideIsolated', false);
    public readonly showHulls = new PersistentValue<boolean>('synaipse.graph.showHulls', false);
    public readonly showHeat = new PersistentValue<boolean>('synaipse.graph.showHeat', false);
    public readonly heatState = new PersistentValue<HeatState>('synaipse.graph.heatState', {}, undefined, 500);
    public readonly showRoomGrid = new PersistentValue<boolean>('synaipse.graph.showRoomGrid', false);
    public readonly showCluster = new PersistentValue<boolean>('synaipse.graph.showCluster', false);
    public readonly showCommunities = new PersistentValue<boolean>('synaipse.graph.showCommunities', false);
    public readonly viewMode = new PersistentValue<ViewMode>('synaipse.graph.viewMode', '2d', viewModeCodec);

    /** Calls `listener` whenever a toggle changes that only alters what the view shows (not heat, not the mode). */
    public onFilterChange(listener: () => void): void {
        this.selectedTags.subscribe(listener);
        this.hideIsolated.subscribe(listener);
        this.showHulls.subscribe(listener);
        this.showRoomGrid.subscribe(listener);
        this.showCommunities.subscribe(listener);
        this.showCluster.subscribe(listener);
    }

    public viewState(data: Graph): GraphRendererState {
        return {
            data,
            selectedTags: this.selectedTags.get(),
            hideIsolated: this.hideIsolated.get(),
            showHulls: this.showHulls.get(),
            showHeat: this.showHeat.get(),
            showRoomGrid: this.showRoomGrid.get(),
            showCluster: this.showCluster.get(),
            showCommunities: this.showCommunities.get()
        };
    }

    public effectiveViewMode(graph: Graph | null): ViewMode {
        return effectiveViewMode(this.viewMode.get(), graph?.nodes.length ?? 0);
    }

    public destroy(): void {
        for (const value of [this.selectedTags, this.hideIsolated, this.showHulls, this.showHeat, this.heatState,
            this.showRoomGrid, this.showCluster, this.showCommunities, this.viewMode]) {
            value.destroy();
        }
    }
}
