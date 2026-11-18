import type {NGraph, NGraphEdgeData, NGraphHull, NGraphNodeData} from 'jsngraph';
import type {Graph as GraphData} from '@synaipse/core';
import {colorForNode, tagColor} from './Colors.js';
import {communityColor, detectCommunities, type CommunityResult} from './Communities.js';
import {el} from './Dom.js';
import type {EventKind} from './Events.js';
import type {GraphRenderer, GraphRendererCallbacks, GraphRendererState} from './GraphRenderer.js';
import {CONCENTRATE_COLOR, PULSE_COLORS, filterGraph} from './GraphRenderer.js';
import {resolvePositions, type PositionMap} from './GraphPositions.js';
import {edgeKinds, loadJsNGraph, readGraphTheme, type JsNGraph} from './GraphStyle.js';
import {normalizeHeat} from './Heat.js';
import {PersistentValue} from './Persistence.js';
import {onThemeChange} from './Theme.js';

const STORAGE_POSITIONS = 'synaipse.graph.positions';
const positionsStore = new PersistentValue<PositionMap>(STORAGE_POSITIONS, {});

export type GraphState = GraphRendererState;
export type GraphCallbacks = GraphRendererCallbacks;

const HULL_PADDING = 24;
const HULL_MIN_NODES = 3;
const HEAT_COLOR = '#ffd166';

interface BuiltGraph {
    nodes: NGraphNodeData[];
    edges: NGraphEdgeData[];
    hulls: NGraphHull[];
    communityCount: number;
}

/** Radius 7..16 by tag count, like the old cytoscape mapData(tagCount, 0, 5, 14, 32) diameter. */
export const nodeRadius = (tagCount: number): number => 7 + (Math.min(5, Math.max(0, tagCount)) / 5) * 9;

/**
 * The visible graph as jsNGraph data: filtered nodes coloured by community
 * or tag, stable edge ids (endpoints + kind, plus a counter for duplicates)
 * and one hull per tag with at least three visible notes.
 */
export const buildGraph = (state: GraphState, communities: CommunityResult | null): BuiltGraph => {
    const filtered = filterGraph(state);
    const useCommunity = state.showCommunities && communities !== null;
    const nodes: NGraphNodeData[] = filtered.nodes.map((n) => {
        const community = communities?.partition.get(n.id);

        return {
            id: n.id,
            label: n.title,
            shape: 'dot',
            color: useCommunity && community !== undefined ? communityColor(community) : colorForNode(n.tags),
            size: nodeRadius(n.tags.length)
        };
    });

    const seen = new Map<string, number>();
    const edges: NGraphEdgeData[] = filtered.edges.map((e) => {
        const key = `e:${e.kind}:${e.from}→${e.to}`;
        const n = seen.get(key) ?? 0;
        seen.set(key, n + 1);
        return {id: n === 0 ? key : `${key}#${n}`, source: e.from, target: e.to, kind: e.kind};
    });

    const hulls: NGraphHull[] = [];

    if (state.showHulls) {
        const byTag = new Map<string, string[]>();

        for (const n of filtered.nodes) {
            for (const tag of n.tags) {
                const ids = byTag.get(tag) ?? [];
                ids.push(n.id);
                byTag.set(tag, ids);
            }
        }

        for (const [tag, ids] of byTag) {
            if (ids.length >= HULL_MIN_NODES) {
                hulls.push({id: tag, nodeIds: ids, color: tagColor(tag), label: `${tag} · ${ids.length}`, padding: HULL_PADDING, opacity: 0.12});
            }
        }
    }

    return {nodes, edges, hulls, communityCount: communities?.count ?? 0};
};

/**
 * The 2D vault graph on jsNGraph (plan P6 / S2), replacing cytoscape:
 * canvas rendering with a static layout. Positions come from the saved
 * arrangement; new notes land next to their neighbours (resolvePositions),
 * drags are persisted. Tag hulls, heat rings and the live-activity effects
 * (pulse, trail, concentrate) are drawn by jsNGraph itself.
 */
export class GraphView implements GraphRenderer {
    public readonly element: HTMLElement;
    private state: GraphState;
    private readonly stage: HTMLElement;
    private readonly stats: HTMLElement;
    private graph: NGraph | null = null;
    private lib: JsNGraph | null = null;
    private destroyed = false;
    private heat: Map<string, number> = new Map();
    private hullLabels: Map<string, string> = new Map();
    private hoveredNode = false;
    private cachedCommunities: {data: GraphData; result: CommunityResult} | null = null;
    private unsubscribeTheme: (() => void) | null = null;

    public constructor(initial: GraphState, private readonly cb: GraphCallbacks) {
        this.state = initial;
        this.element = el('div', {class: 'graph-canvas'});
        this.stage = el('div', {class: 'graph'});
        this.stats = el('div', {class: 'graph-stats'});
        this.element.appendChild(this.stage);
        // After the stage: the canvas paints its own background.
        this.element.appendChild(this.stats);
    }

    public mount(): void {
        void this.init();
    }

    public update(state: GraphState): void {
        this.state = state;
        this.render();
    }

    public destroy(): void {
        this.destroyed = true;
        this.unsubscribeTheme?.();
        this.unsubscribeTheme = null;
        this.graph?.destroy();
        this.graph = null;
    }

    public applyHeat(heatById: ReadonlyMap<string, number>): void {
        const heat = new Map<string, number>();

        for (const [id, raw] of heatById) {
            const h = normalizeHeat(raw);
            if (h > 0) heat.set(id, h);
        }

        this.heat = heat;
        this.graph?.redraw();
    }

    public pulse(noteIds: readonly string[], kind: EventKind): void {
        if (noteIds.length > 0) this.graph?.pulse(noteIds, PULSE_COLORS[kind], {durationMs: 1400});
    }

    public trail(fromId: string, toId: string, kind: EventKind): void {
        this.graph?.trail(fromId, toId, PULSE_COLORS[kind], {durationMs: 2200, curve: 28});
    }

    public concentrate(noteId: string): void {
        this.graph?.ripple(noteId, CONCENTRATE_COLOR, {waves: 2, delayMs: 220, durationMs: 1100, endRadius: 140});
    }

    public focus(_noteId: string): void {
        // Called on every live event; moving the 2D camera each time would
        // fight the user. Intentional no-op (the 3D view orbits instead).
    }

    private async init(): Promise<void> {
        const lib = await loadJsNGraph();

        if (this.destroyed) return;

        this.lib = lib;
        this.graph = new lib.NGraph(this.stage, {
            theme: readGraphTheme(lib, this.element),
            layoutMode: 'static',
            panZoom: true,
            detailPanel: false,
            draggable: true,
            grid: false,
            lasso: false,
            // cytoscape hid labels below ~7 px on screen at a 10 px font.
            labelMinZoom: 0.7,
            edgeKinds: {
                ...edgeKinds(lib),
                // Solid with an arrow, as before; solid edges are also drawn batched.
                wikilink: {tone: 'neutral', directed: true, animated: false},
                tag: {tone: 'neutral', directed: true, animated: false}
            },
            tooltip: (node) => node.label,
            styleNode: (node) => {
                const h = this.state.showHeat ? this.heat.get(node.id) : undefined;
                return h === undefined ? null : {ring: {color: HEAT_COLOR, width: 1.5 + h * 4.5, opacity: 0.35 + h * 0.55}};
            }
        });

        this.graph.on('nodeClick', (node) => {
            if (node !== null) this.cb.onSelectNote(node.id);
        });
        this.graph.on('nodeDragEnd', () => this.snapshotPositions());
        this.graph.on('nodeHover', (node) => {
            this.hoveredNode = node !== null;
            if (this.hoveredNode) this.stage.title = '';
        });
        this.stage.addEventListener('mousemove', this.onMouseMove);
        this.unsubscribeTheme = onThemeChange(() => {
            if (this.graph !== null && this.lib !== null) this.graph.setTheme(readGraphTheme(this.lib, this.element));
        });

        this.render(true);
    }

    /** Tag name and size as a native tooltip over a hull (not over a node). */
    private readonly onMouseMove = (event: MouseEvent): void => {
        if (this.graph === null || this.hoveredNode || this.hullLabels.size === 0) {
            if (this.stage.title !== '') this.stage.title = '';
            return;
        }

        const rect = this.stage.getBoundingClientRect();
        const ids = this.graph.hullsAt(event.clientX - rect.left, event.clientY - rect.top);
        const title = ids.map((id) => this.hullLabels.get(id) ?? id).join('\n');

        if (this.stage.title !== title) this.stage.title = title;
    };

    private getCommunities(): CommunityResult | null {
        if (!this.state.showCommunities) return null;

        if (this.cachedCommunities !== null && this.cachedCommunities.data === this.state.data) {
            return this.cachedCommunities.result;
        }

        const result = detectCommunities(this.state.data.nodes, this.state.data.edges);
        this.cachedCommunities = {data: this.state.data, result};
        return result;
    }

    /**
     * Bring the graph to the current state. Live positions win over saved
     * ones, so a write elsewhere does not move anything; new notes are
     * placed next to their neighbours. The camera and selection stay
     * (setData keeps both), only the first render fits the view.
     */
    private render(first = false): void {
        const graph = this.graph;
        if (graph === null) return;

        const built = buildGraph(this.state, this.getCommunities());
        const statsParts = [`${built.nodes.length} nodes`, `${built.edges.length} edges`];

        if (this.state.showCommunities && built.communityCount > 0) {
            statsParts.push(`${built.communityCount} communities`);
        }

        this.stats.textContent = statsParts.join(' · ');

        const anchors: PositionMap = {...positionsStore.get(), ...graph.getPositions()};
        const positions = resolvePositions(built.nodes.map((n) => n.id), built.edges, anchors);

        for (const node of built.nodes) {
            const pos = positions.get(node.id);

            if (pos !== undefined) {
                node.x = pos.x;
                node.y = pos.y;
            }
        }

        graph.setData(built.nodes, built.edges);
        graph.setHulls(built.hulls);
        this.hullLabels = new Map(built.hulls.map((h) => [h.id, h.label ?? h.id]));

        if (first) {
            graph.fit({padding: 24});
            // Persist the placement of notes that had no saved position yet.
            this.snapshotPositions();
        }
    }

    private snapshotPositions(): void {
        if (this.graph === null) return;
        positionsStore.set({...positionsStore.get(), ...this.graph.getPositions()});
    }
}
