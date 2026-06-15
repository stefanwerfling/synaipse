import type {Graph as GraphData} from '@synaipse/core';
import type {EventKind} from './Events.js';

export interface GraphRendererState {
    data: GraphData;
    selectedTags: ReadonlySet<string>;
    hideIsolated: boolean;
    showHulls: boolean;
    showHeat: boolean;
    showRoomGrid: boolean;
    showCluster: boolean;
    showCommunities: boolean;
}

export interface GraphRendererCallbacks {
    onSelectNote: (noteId: string) => void;
}

export interface GraphRenderer {
    readonly element: HTMLElement;
    mount(): void;
    update(state: GraphRendererState): void;
    pulse(noteIds: readonly string[], kind: EventKind): void;
    trail(fromId: string, toId: string, kind: EventKind): void;
    concentrate(noteId: string): void;
    focus(noteId: string): void;
    applyHeat(heatById: ReadonlyMap<string, number>): void;
    destroy(): void;
}

export const filterGraph = (state: GraphRendererState): {
    nodes: GraphData['nodes'];
    edges: GraphData['edges'];
    visibleNodeCount: number;
    visibleEdgeCount: number;
} => {
    const tagOk = (nodeTags: string[]): boolean => {
        if (state.selectedTags.size === 0) {
            return true;
        }

        return nodeTags.some((t) => state.selectedTags.has(t));
    };

    const visibleIds = new Set<string>();

    for (const node of state.data.nodes) {
        if (tagOk(node.tags)) {
            visibleIds.add(node.id);
        }
    }

    const edges = state.data.edges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));

    if (state.hideIsolated) {
        const endpoints = new Set<string>();

        for (const e of edges) {
            endpoints.add(e.from);
            endpoints.add(e.to);
        }

        for (const id of visibleIds) {
            if (!endpoints.has(id)) {
                visibleIds.delete(id);
            }
        }
    }

    const nodes = state.data.nodes.filter((n) => visibleIds.has(n.id));
    const finalEdges = edges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));

    return {nodes, edges: finalEdges, visibleNodeCount: nodes.length, visibleEdgeCount: finalEdges.length};
};

export const CONCENTRATE_COLOR = '#ffd166';

export const concentrateRadius = (elapsedMs: number, durationMs: number, start: number, end: number): number => {
    const t = Math.min(1, Math.max(0, elapsedMs / durationMs));
    const eased = 1 - Math.pow(1 - t, 3);
    return start + (end - start) * eased;
};

export const concentrateOpacity = (elapsedMs: number, durationMs: number): number => {
    const t = Math.min(1, Math.max(0, elapsedMs / durationMs));
    return Math.max(0, 1 - t);
};

export const PULSE_COLORS: Record<EventKind, string> = {
    read: '#6c9aff',
    search: '#ffb86c',
    write: '#34d399',
    delete: '#f87171',
    list: '#a78bfa',
    graph: '#5b8def',
    tags: '#f472b6'
};