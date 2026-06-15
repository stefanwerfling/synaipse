import cytoscape, {Core, ElementDefinition} from 'cytoscape';
import type {Graph as GraphData} from '@synaipse/core';
import {colorForNode, tagColor} from './Colors.js';
import {communityColor, detectCommunities, type CommunityResult} from './Communities.js';
import {clear, el} from './Dom.js';
import type {EventKind} from './Events.js';
import type {GraphRenderer, GraphRendererCallbacks, GraphRendererState} from './GraphRenderer.js';
import {CONCENTRATE_COLOR, PULSE_COLORS, concentrateOpacity, concentrateRadius} from './GraphRenderer.js';
import {normalizeHeat} from './Heat.js';
import {convexHull, expandHull, toSvgPoints, type Point} from './Hulls.js';
import {PersistentValue} from './Persistence.js';
import {bezierControl, trailOpacity, trailSvgPath} from './Trail.js';

const STORAGE_POSITIONS = 'synaipse.graph.positions';
type PositionMap = Record<string, {x: number; y: number}>;
const positionsStore = new PersistentValue<PositionMap>(STORAGE_POSITIONS, {});

export type GraphState = GraphRendererState;

const SVG_NS = 'http://www.w3.org/2000/svg';
const HULL_PADDING = 24;
const TRAIL_DURATION_MS = 2200;
const TRAIL_CURVE = 28;
const WAVE_DURATION_MS = 1100;
const WAVE_END_RADIUS = 140;
const WAVE_SECONDARY_DELAY_MS = 220;

interface TrailRecord {
    path: SVGPathElement;
    fromId: string;
    toId: string;
    color: string;
    startedAt: number;
}

interface WaveRecord {
    circle: SVGCircleElement;
    nodeId: string;
    startRadius: number;
    startedAt: number;
}

export type GraphCallbacks = GraphRendererCallbacks;

interface FilterResult {
    elements: ElementDefinition[];
    visibleNodeCount: number;
    visibleEdgeCount: number;
    communityCount: number;
}

const buildElements = (state: GraphState, communities: CommunityResult | null): FilterResult => {
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

    const filteredEdges = state.data.edges.filter(
        (e) => visibleIds.has(e.from) && visibleIds.has(e.to)
    );

    if (state.hideIsolated) {
        const endpoints = new Set<string>();
        for (const e of filteredEdges) {
            endpoints.add(e.from);
            endpoints.add(e.to);
        }

        for (const id of visibleIds) {
            if (!endpoints.has(id)) {
                visibleIds.delete(id);
            }
        }
    }

    const useCommunity = state.showCommunities && communities !== null;

    const nodes: ElementDefinition[] = state.data.nodes
        .filter((n) => visibleIds.has(n.id))
        .map((n) => {
            const community = communities?.partition.get(n.id);
            const color = useCommunity && community !== undefined
                ? communityColor(community)
                : colorForNode(n.tags);

            return {
                data: {
                    id: n.id,
                    label: n.title,
                    color,
                    tagCount: n.tags.length
                }
            };
        });

    const edges: ElementDefinition[] = filteredEdges
        .filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to))
        .map((e, i) => ({
            data: {id: `e${i}`, source: e.from, target: e.to, kind: e.kind}
        }));

    return {
        elements: [...nodes, ...edges],
        visibleNodeCount: nodes.length,
        visibleEdgeCount: edges.length,
        communityCount: communities?.count ?? 0
    };
};

export class GraphView implements GraphRenderer {
    public readonly element: HTMLElement;
    private state: GraphState;
    private canvas: HTMLElement;
    private stats: HTMLElement;
    private hullLayer: SVGSVGElement;
    private trailLayer: SVGSVGElement;
    private waveLayer: SVGSVGElement;
    private cy: Core | null = null;
    private rafHandle: number | null = null;
    private trailRaf: number | null = null;
    private waveRaf: number | null = null;
    private nodeIndex: Map<string, GraphData['nodes'][number]> = new Map();
    private cachedCommunities: {data: GraphData; result: CommunityResult} | null = null;
    private trails: TrailRecord[] = [];
    private waves: WaveRecord[] = [];

    public constructor(initial: GraphState, private readonly cb: GraphCallbacks) {
        this.state = initial;
        this.element = el('div', {class: 'graph-canvas'});
        this.stats = el('div', {class: 'graph-stats'});
        this.hullLayer = document.createElementNS(SVG_NS, 'svg');
        this.hullLayer.setAttribute('class', 'graph-hulls');
        this.hullLayer.setAttribute('preserveAspectRatio', 'none');
        this.trailLayer = document.createElementNS(SVG_NS, 'svg');
        this.trailLayer.setAttribute('class', 'graph-trails');
        this.trailLayer.setAttribute('preserveAspectRatio', 'none');
        this.waveLayer = document.createElementNS(SVG_NS, 'svg');
        this.waveLayer.setAttribute('class', 'graph-waves');
        this.waveLayer.setAttribute('preserveAspectRatio', 'none');
        this.canvas = el('div', {class: 'graph'});
        this.element.appendChild(this.stats);
        this.element.appendChild(this.hullLayer);
        this.element.appendChild(this.canvas);
        this.element.appendChild(this.trailLayer);
        this.element.appendChild(this.waveLayer);
    }

    public mount(): void {
        this.render();
    }

    public update(state: GraphState): void {
        this.state = state;
        this.render();
    }

    public destroy(): void {
        if (this.rafHandle !== null) {
            cancelAnimationFrame(this.rafHandle);
            this.rafHandle = null;
        }
        if (this.trailRaf !== null) {
            cancelAnimationFrame(this.trailRaf);
            this.trailRaf = null;
        }
        if (this.waveRaf !== null) {
            cancelAnimationFrame(this.waveRaf);
            this.waveRaf = null;
        }
        for (const trail of this.trails) {
            trail.path.remove();
        }
        this.trails = [];
        for (const wave of this.waves) {
            wave.circle.remove();
        }
        this.waves = [];
        if (this.cy !== null) {
            this.cy.destroy();
            this.cy = null;
        }
    }

    public applyHeat(heatById: ReadonlyMap<string, number>): void {
        if (this.cy === null) {
            return;
        }

        if (!this.state.showHeat) {
            this.cy.nodes().forEach((node) => {
                node.removeStyle('border-width border-color border-opacity');
            });
            return;
        }

        this.cy.nodes().forEach((node) => {
            const raw = heatById.get(node.id()) ?? 0;
            const heat = normalizeHeat(raw);

            if (heat <= 0) {
                node.removeStyle('border-width border-color border-opacity');
                return;
            }

            node.style({
                'border-width': 2 + heat * 6,
                'border-color': '#ffd166',
                'border-opacity': 0.35 + heat * 0.55
            });
        });
    }

    public trail(fromId: string, toId: string, kind: EventKind): void {
        if (this.cy === null || fromId === toId) {
            return;
        }

        const from = this.cy.getElementById(fromId);
        const to = this.cy.getElementById(toId);

        if (from.length === 0 || to.length === 0 || !from.isNode() || !to.isNode()) {
            return;
        }

        const a = from.renderedPosition();
        const b = to.renderedPosition();
        const control = bezierControl({x: a.x, y: a.y}, {x: b.x, y: b.y}, TRAIL_CURVE);
        const color = PULSE_COLORS[kind];

        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', trailSvgPath({x: a.x, y: a.y}, {x: b.x, y: b.y}, control));
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', '2.4');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-opacity', '0.95');
        path.setAttribute('filter', `drop-shadow(0 0 6px ${color})`);

        this.trailLayer.appendChild(path);

        this.trails.push({path, fromId, toId, color, startedAt: performance.now()});
        this.scheduleTrailTick();
    }

    private scheduleTrailTick(): void {
        if (this.trailRaf !== null) {
            return;
        }

        const tick = (): void => {
            const now = performance.now();
            const survivors: TrailRecord[] = [];

            for (const trail of this.trails) {
                const elapsed = now - trail.startedAt;
                const opacity = trailOpacity(elapsed, TRAIL_DURATION_MS);

                if (opacity <= 0) {
                    trail.path.remove();
                    continue;
                }

                trail.path.setAttribute('stroke-opacity', opacity.toFixed(3));

                if (this.cy !== null) {
                    const from = this.cy.getElementById(trail.fromId);
                    const to = this.cy.getElementById(trail.toId);

                    if (from.length > 0 && to.length > 0 && from.isNode() && to.isNode()) {
                        const a = from.renderedPosition();
                        const b = to.renderedPosition();
                        const control = bezierControl({x: a.x, y: a.y}, {x: b.x, y: b.y}, TRAIL_CURVE);
                        trail.path.setAttribute('d', trailSvgPath({x: a.x, y: a.y}, {x: b.x, y: b.y}, control));
                    }
                }

                survivors.push(trail);
            }

            this.trails = survivors;

            if (this.trails.length === 0) {
                this.trailRaf = null;
                return;
            }

            this.trailRaf = requestAnimationFrame(tick);
        };

        this.trailRaf = requestAnimationFrame(tick);
    }

    public pulse(noteIds: readonly string[], kind: EventKind): void {
        if (this.cy === null || noteIds.length === 0) {
            return;
        }

        const color = PULSE_COLORS[kind];

        for (const id of noteIds) {
            const node = this.cy.getElementById(id);

            if (node.length === 0 || !node.isNode()) {
                continue;
            }

            node.stop(true, true);
            node.style({
                'overlay-color': color,
                'overlay-opacity': 0.55,
                'overlay-padding': 14
            });

            node.animate(
                {
                    style: {
                        'overlay-opacity': 0,
                        'overlay-padding': 28
                    }
                },
                {duration: 1400, easing: 'ease-out'}
            );
        }
    }

    public focus(_noteId: string): void {
        // 2D: no camera, nothing to orbit. Intentional no-op.
    }

    public concentrate(noteId: string): void {
        if (this.cy === null) {
            return;
        }

        const node = this.cy.getElementById(noteId);

        if (node.length === 0 || !node.isNode()) {
            return;
        }

        const startRadius = Math.max(8, node.renderedOuterWidth() / 2);
        this.spawnWave(noteId, startRadius, 0);
        this.spawnWave(noteId, startRadius, WAVE_SECONDARY_DELAY_MS);
        this.scheduleWaveTick();
    }

    private spawnWave(nodeId: string, startRadius: number, delayMs: number): void {
        if (this.cy === null) {
            return;
        }

        const node = this.cy.getElementById(nodeId);

        if (node.length === 0 || !node.isNode()) {
            return;
        }

        const pos = node.renderedPosition();
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('cx', pos.x.toString());
        circle.setAttribute('cy', pos.y.toString());
        circle.setAttribute('r', startRadius.toString());
        circle.setAttribute('fill', 'none');
        circle.setAttribute('stroke', CONCENTRATE_COLOR);
        circle.setAttribute('stroke-width', '2.4');
        circle.setAttribute('stroke-opacity', '0');
        circle.setAttribute('filter', `drop-shadow(0 0 8px ${CONCENTRATE_COLOR})`);

        this.waveLayer.appendChild(circle);

        this.waves.push({
            circle,
            nodeId,
            startRadius,
            startedAt: performance.now() + delayMs
        });
    }

    private scheduleWaveTick(): void {
        if (this.waveRaf !== null) {
            return;
        }

        const tick = (): void => {
            const now = performance.now();
            const survivors: WaveRecord[] = [];

            for (const wave of this.waves) {
                const elapsed = now - wave.startedAt;

                if (elapsed < 0) {
                    survivors.push(wave);
                    continue;
                }

                if (elapsed >= WAVE_DURATION_MS) {
                    wave.circle.remove();
                    continue;
                }

                const radius = concentrateRadius(elapsed, WAVE_DURATION_MS, wave.startRadius, WAVE_END_RADIUS);
                const opacity = concentrateOpacity(elapsed, WAVE_DURATION_MS);
                const widthFactor = 1 - elapsed / WAVE_DURATION_MS;

                if (this.cy !== null) {
                    const node = this.cy.getElementById(wave.nodeId);

                    if (node.length > 0 && node.isNode()) {
                        const pos = node.renderedPosition();
                        wave.circle.setAttribute('cx', pos.x.toString());
                        wave.circle.setAttribute('cy', pos.y.toString());
                    }
                }

                wave.circle.setAttribute('r', radius.toFixed(2));
                wave.circle.setAttribute('stroke-opacity', (opacity * 0.95).toFixed(3));
                wave.circle.setAttribute('stroke-width', (1.2 + widthFactor * 2.4).toFixed(2));

                survivors.push(wave);
            }

            this.waves = survivors;

            if (this.waves.length === 0) {
                this.waveRaf = null;
                return;
            }

            this.waveRaf = requestAnimationFrame(tick);
        };

        this.waveRaf = requestAnimationFrame(tick);
    }

    private getCommunities(): CommunityResult | null {
        if (!this.state.showCommunities) return null;

        if (this.cachedCommunities !== null && this.cachedCommunities.data === this.state.data) {
            return this.cachedCommunities.result;
        }

        const result = detectCommunities(this.state.data.nodes, this.state.data.edges);
        this.cachedCommunities = {data: this.state.data, result};
        return result;
    }

    private render(): void {
        if (this.cy !== null) {
            this.cy.destroy();
            this.cy = null;
        }

        const communities = this.getCommunities();
        const filter = buildElements(this.state, communities);
        clear(this.stats);
        const statsParts = [`${filter.visibleNodeCount} nodes`, `${filter.visibleEdgeCount} edges`];

        if (this.state.showCommunities && filter.communityCount > 0) {
            statsParts.push(`${filter.communityCount} communities`);
        }

        this.stats.textContent = statsParts.join(' · ');

        const savedPositions = positionsStore.get();
        const nodeIds = filter.elements
            .filter((e) => e.data.source === undefined)
            .map((e) => e.data.id as string);
        const haveAllPositions = nodeIds.length > 0 && nodeIds.every((id) => savedPositions[id] !== undefined);

        const elementsWithPositions = filter.elements.map((e) => {
            const id = e.data.id;
            const isNode = e.data.source === undefined;
            const pos = isNode && typeof id === 'string' ? savedPositions[id] : undefined;
            return pos !== undefined ? {...e, position: pos} : e;
        });

        this.cy = cytoscape({
            container: this.canvas,
            elements: elementsWithPositions,
            hideEdgesOnViewport: true,
            textureOnViewport: true,
            pixelRatio: 1,
            style: [
                {
                    selector: 'node',
                    style: {
                        'background-color': 'data(color)',
                        'label': 'data(label)',
                        'color': '#e6e6e6',
                        'font-size': 10,
                        'text-valign': 'bottom',
                        'text-margin-y': 4,
                        'text-outline-width': 2,
                        'text-outline-color': '#0f1115',
                        'width': 'mapData(tagCount, 0, 5, 14, 32)',
                        'height': 'mapData(tagCount, 0, 5, 14, 32)'
                    }
                },
                {
                    selector: 'edge',
                    style: {
                        'width': 1,
                        'line-color': '#3a3f4b',
                        'target-arrow-color': '#3a3f4b',
                        'target-arrow-shape': 'triangle',
                        'curve-style': 'bezier',
                        'arrow-scale': 0.8
                    }
                },
                {
                    selector: 'node:selected',
                    style: {'border-width': 2, 'border-color': '#ffb86c'}
                }
            ],
            layout: haveAllPositions
                ? {name: 'preset', fit: true, padding: 24}
                : {
                    name: 'cose',
                    animate: false,
                    idealEdgeLength: () => 80,
                    nodeRepulsion: () => 8000,
                    padding: 24,
                    fit: true
                },
            wheelSensitivity: 0.2
        });

        this.cy.on('tap', 'node', (event) => {
            this.cb.onSelectNote(event.target.id());
        });

        this.nodeIndex = new Map(this.state.data.nodes.map((n) => [n.id, n]));

        this.cy.on('pan zoom resize layoutstop', () => this.scheduleHullRender());
        this.cy.on('layoutstop', () => this.snapshotPositions());
        // dragfree fires when the user finishes dragging a single node — capture that too
        this.cy.on('dragfree', 'node', () => this.snapshotPositions());
        this.scheduleHullRender();
    }

    private snapshotPositions(): void {
        if (this.cy === null) return;

        const out: PositionMap = {...positionsStore.get()};

        this.cy.nodes().forEach((node) => {
            const id = node.id();
            const pos = node.position();
            out[id] = {x: pos.x, y: pos.y};
        });

        positionsStore.set(out);
    }

    private scheduleHullRender(): void {
        if (this.rafHandle !== null) {
            return;
        }

        this.rafHandle = requestAnimationFrame(() => {
            this.rafHandle = null;
            this.renderHulls();
        });
    }

    private renderHulls(): void {
        clear(this.hullLayer as unknown as HTMLElement);

        if (this.cy === null || !this.state.showHulls) {
            return;
        }

        const tagToPoints = new Map<string, Point[]>();

        this.cy.nodes().forEach((node) => {
            const info = this.nodeIndex.get(node.id());

            if (info === undefined) {
                return;
            }

            const pos = node.renderedPosition();

            for (const tag of info.tags) {
                const points = tagToPoints.get(tag) ?? [];
                points.push([pos.x, pos.y]);
                tagToPoints.set(tag, points);
            }
        });

        for (const [tag, points] of tagToPoints) {
            if (points.length < 3) {
                continue;
            }

            const hull = expandHull(convexHull(points), HULL_PADDING);
            const color = tagColor(tag);
            const poly = document.createElementNS(SVG_NS, 'polygon');
            poly.setAttribute('points', toSvgPoints(hull));
            poly.setAttribute('fill', color);
            poly.setAttribute('fill-opacity', '0.12');
            poly.setAttribute('stroke', color);
            poly.setAttribute('stroke-opacity', '0.35');
            poly.setAttribute('stroke-width', '1');
            poly.setAttribute('stroke-linejoin', 'round');

            const title = document.createElementNS(SVG_NS, 'title');
            title.textContent = `${tag} · ${points.length}`;
            poly.appendChild(title);

            this.hullLayer.appendChild(poly);
        }
    }
}