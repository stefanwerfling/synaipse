import type {Graph as GraphData} from '@synaipse/core';
import {api, type GraphLayout} from './Api.js';
import {communityColor} from './Communities.js';
import {el} from './Dom.js';
import type {EventKind} from './Events.js';
import type {GraphRenderer, GraphRendererCallbacks, GraphRendererState} from './GraphRenderer.js';
import {Quadtree} from './Quadtree.js';

/**
 * Atlas view — server-precomputed Louvain layout, rendered on a plain canvas.
 *
 * The 2D (Cytoscape) and 3D (three.js) views recompute force-directed
 * positions every frame; once the graph passes ~5k nodes that grinds. This
 * one fetches positions once, blits them, and lets the user pan/zoom across
 * the map. Edges are viewport-culled — they only render when zoomed in
 * enough that they'd be visible anyway.
 */

const NODE_BASE_RADIUS = 3;
const NODE_HIT_PADDING = 4;
/** Below this zoom we only draw aggregated community super-nodes. */
const COMMUNITY_AGGREGATE_ZOOM = 0.5;
const EDGE_VISIBLE_ZOOM = 1.0;
const LABEL_VISIBLE_ZOOM = 1.5;

interface ViewState {
    scale: number;
    offsetX: number;
    offsetY: number;
}

export class GraphAtlasView implements GraphRenderer {
    public readonly element: HTMLElement;
    private state: GraphRendererState;
    private canvas!: HTMLCanvasElement;
    private overlay!: HTMLElement;
    private stats!: HTMLElement;
    private layout: GraphLayout | null = null;
    private edges: GraphData['edges'] = [];
    private nodeIndex = new Map<string, GraphLayout['nodes'][number]>();
    private nodeTree: Quadtree<string> | null = null;
    private communityTree: Quadtree<number> | null = null;
    private view: ViewState = {scale: 1, offsetX: 0, offsetY: 0};
    private rafHandle: number | null = null;
    private dragging = false;
    private dragLast: {x: number; y: number} | null = null;
    private hoverId: string | null = null;
    private heatById: ReadonlyMap<string, number> = new Map();
    private pendingFetch: Promise<void> | null = null;
    private listenerAbort: AbortController | null = null;
    private resizeObserver: ResizeObserver | null = null;

    public constructor(initial: GraphRendererState, private readonly cb: GraphRendererCallbacks) {
        this.state = initial;
        this.element = el('div', {class: 'graph-canvas atlas'});
        this.build();
    }

    public mount(): void {
        void this.refreshLayout();
        this.installInteractions();
        this.scheduleRender();
    }

    public update(state: GraphRendererState): void {
        const dataChanged = state.data !== this.state.data;
        this.state = state;

        if (dataChanged) {
            void this.refreshLayout();
            return;
        }

        this.scheduleRender();
    }

    public destroy(): void {
        if (this.rafHandle !== null) {
            cancelAnimationFrame(this.rafHandle);
            this.rafHandle = null;
        }
        // Without this, the window-level mousemove/mouseup listeners keep
        // firing after the tab is unmounted — noticeable as jank in the
        // notes view whenever the pointer moves.
        this.listenerAbort?.abort();
        this.listenerAbort = null;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.layout = null;
        this.nodeIndex.clear();
        this.nodeTree = null;
        this.communityTree = null;
        this.edges = [];
    }

    public pulse(_noteIds: readonly string[], _kind: EventKind): void {
        // Atlas is static — visual ephemera (pulses, trails) belong in the
        // animated views. Intentionally no-op.
    }

    public trail(_fromId: string, _toId: string, _kind: EventKind): void {}

    public concentrate(_noteId: string): void {}

    public focus(noteId: string): void {
        const node = this.layout?.nodes.find((n) => n.id === noteId);
        if (node === undefined) return;
        this.centreOn(node.x, node.y);
        this.scheduleRender();
    }

    public applyHeat(heatById: ReadonlyMap<string, number>): void {
        this.heatById = heatById;
        this.scheduleRender();
    }

    private build(): void {
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'atlas-canvas';
        this.stats = el('div', {class: 'graph-stats'});
        this.overlay = el('div', {class: 'atlas-overlay'});

        this.element.appendChild(this.stats);
        this.element.appendChild(this.canvas);
        this.element.appendChild(this.overlay);
    }

    private async refreshLayout(): Promise<void> {
        if (this.pendingFetch !== null) return;

        const nodeCount = this.state.data.nodes.length;
        const edgeCount = this.state.data.edges.length;
        const started = Date.now();
        this.stats.textContent = `computing layout for ${nodeCount} nodes / ${edgeCount} edges…`;

        this.pendingFetch = (async () => {
            try {
                this.layout = await api.getGraphLayout();
                this.edges = [...this.state.data.edges];
                this.nodeIndex = new Map(this.layout.nodes.map((n) => [n.id, n]));
                this.buildSpatialIndex();
                this.fitToContent();
                const ms = Date.now() - started;
                this.stats.textContent = `${this.layout.nodes.length} nodes · ${this.edges.length} edges · ${this.layout.communities.length} communities · ${ms}ms`;
            } catch (cause) {
                this.stats.textContent = `layout failed: ${String(cause)}`;
            } finally {
                this.pendingFetch = null;
                this.scheduleRender();
            }
        })();

        await this.pendingFetch;
    }

    private buildSpatialIndex(): void {
        if (this.layout === null) return;
        const b = this.layout.bounds;
        const nodes = new Quadtree<string>({minX: -50, minY: -50, maxX: b.width + 50, maxY: b.height + 50});
        for (const n of this.layout.nodes) nodes.add({x: n.x, y: n.y, payload: n.id});
        this.nodeTree = nodes;

        const communities = new Quadtree<number>({minX: -50, minY: -50, maxX: b.width + 50, maxY: b.height + 50});
        for (const c of this.layout.communities) communities.add({x: c.cx, y: c.cy, payload: c.id});
        this.communityTree = communities;
    }

    private fitToContent(): void {
        if (this.layout === null || this.layout.nodes.length === 0) return;

        const rect = this.canvas.getBoundingClientRect();
        const cw = rect.width;
        const ch = rect.height;
        const w = this.layout.bounds.width;
        const h = this.layout.bounds.height;

        if (cw === 0 || ch === 0 || w === 0 || h === 0) {
            this.view = {scale: 1, offsetX: 0, offsetY: 0};
            return;
        }

        const scale = Math.min(cw / w, ch / h) * 0.9;
        this.view = {
            scale,
            offsetX: (cw - w * scale) / 2,
            offsetY: (ch - h * scale) / 2
        };
    }

    private installInteractions(): void {
        const canvas = this.canvas;
        // AbortController lets us tear down every DOM listener in destroy()
        // with a single abort() call — including the window-level ones that
        // would otherwise keep firing on a dead canvas.
        this.listenerAbort = new AbortController();
        const signal = this.listenerAbort.signal;

        canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const mx = event.clientX - rect.left;
            const my = event.clientY - rect.top;
            const before = this.unproject(mx, my);
            const delta = event.deltaY > 0 ? 0.9 : 1 / 0.9;
            this.view.scale = Math.max(0.05, Math.min(40, this.view.scale * delta));
            const after = this.unproject(mx, my);
            this.view.offsetX += (after.x - before.x) * this.view.scale;
            this.view.offsetY += (after.y - before.y) * this.view.scale;
            this.scheduleRender();
        }, {passive: false, signal});

        canvas.addEventListener('mousedown', (event) => {
            this.dragging = true;
            this.dragLast = {x: event.clientX, y: event.clientY};
        }, {signal});

        window.addEventListener('mouseup', () => {
            this.dragging = false;
            this.dragLast = null;
        }, {signal});

        window.addEventListener('mousemove', (event) => {
            if (this.dragging && this.dragLast !== null) {
                this.view.offsetX += event.clientX - this.dragLast.x;
                this.view.offsetY += event.clientY - this.dragLast.y;
                this.dragLast = {x: event.clientX, y: event.clientY};
                this.scheduleRender();
                return;
            }

            const rect = canvas.getBoundingClientRect();
            if (event.target !== canvas) {
                if (this.hoverId !== null) {
                    this.hoverId = null;
                    this.overlay.textContent = '';
                }
                return;
            }

            const mx = event.clientX - rect.left;
            const my = event.clientY - rect.top;
            this.hoverId = this.hitTest(mx, my);
            this.renderHoverTooltip(mx, my);
        }, {signal});

        canvas.addEventListener('click', (event) => {
            // At low zoom we hit-test communities → zoom into the tile rather
            // than firing onSelectNote (we don't have a note to open).
            if (this.view.scale < COMMUNITY_AGGREGATE_ZOOM) {
                const rect = canvas.getBoundingClientRect();
                const cid = this.hitTestCommunity(event.clientX - rect.left, event.clientY - rect.top);
                if (cid !== null) this.zoomToCommunity(cid);
                return;
            }

            if (this.hoverId !== null) this.cb.onSelectNote(this.hoverId);
        }, {signal});

        this.resizeObserver = new ResizeObserver(() => {
            this.resizeCanvas();
            this.scheduleRender();
        });
        this.resizeObserver.observe(this.element);
    }

    private resizeCanvas(): void {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio ?? 1;
        this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
        this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
        const ctx = this.canvas.getContext('2d');
        if (ctx !== null) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    private centreOn(worldX: number, worldY: number): void {
        const rect = this.canvas.getBoundingClientRect();
        this.view.offsetX = rect.width / 2 - worldX * this.view.scale;
        this.view.offsetY = rect.height / 2 - worldY * this.view.scale;
    }

    private zoomToCommunity(communityId: number): void {
        if (this.layout === null) return;
        const c = this.layout.communities.find((x) => x.id === communityId);
        if (c === undefined) return;
        const rect = this.canvas.getBoundingClientRect();
        // Zoom enough so the community fills ~60% of the smaller viewport edge.
        const target = (Math.min(rect.width, rect.height) * 0.6) / (c.radius * 2);
        this.view.scale = Math.max(target, EDGE_VISIBLE_ZOOM + 0.05);
        this.centreOn(c.cx, c.cy);
        this.scheduleRender();
    }

    private project(x: number, y: number): {x: number; y: number} {
        return {
            x: x * this.view.scale + this.view.offsetX,
            y: y * this.view.scale + this.view.offsetY
        };
    }

    private unproject(sx: number, sy: number): {x: number; y: number} {
        return {
            x: (sx - this.view.offsetX) / this.view.scale,
            y: (sy - this.view.offsetY) / this.view.scale
        };
    }

    private hitTest(sx: number, sy: number): string | null {
        if (this.nodeTree === null) return null;
        const world = this.unproject(sx, sy);
        const radius = (NODE_BASE_RADIUS + NODE_HIT_PADDING) / this.view.scale;
        return this.nodeTree.nearest(world.x, world.y, radius)?.point.payload ?? null;
    }

    private hitTestCommunity(sx: number, sy: number): number | null {
        if (this.communityTree === null || this.layout === null) return null;
        const world = this.unproject(sx, sy);
        // Each community is drawn with `r = sqrt(size) * scale`. Query big.
        const maxRadius = Math.max(...this.layout.communities.map((c) => Math.sqrt(c.size) * 8 + 6));
        const hit = this.communityTree.nearest(world.x, world.y, maxRadius / this.view.scale);
        if (hit === null) return null;

        // Verify the click is actually within the rendered radius of the closest community.
        const community = this.layout.communities.find((c) => c.id === hit.point.payload);
        if (community === undefined) return null;
        const renderRadius = (Math.sqrt(community.size) * 8 + 6) / this.view.scale;
        return hit.distance <= renderRadius ? hit.point.payload : null;
    }

    private renderHoverTooltip(sx: number, sy: number): void {
        if (this.hoverId === null) {
            this.overlay.style.display = 'none';
            return;
        }

        const node = this.state.data.nodes.find((n) => n.id === this.hoverId);
        if (node === undefined) {
            this.overlay.style.display = 'none';
            return;
        }

        this.overlay.style.display = 'block';
        this.overlay.style.left = `${sx + 12}px`;
        this.overlay.style.top = `${sy + 12}px`;
        this.overlay.textContent = `${node.title} · ${node.tags.slice(0, 3).join(', ')}`;
    }

    private scheduleRender(): void {
        if (this.rafHandle !== null) return;
        this.rafHandle = requestAnimationFrame(() => {
            this.rafHandle = null;
            this.render();
        });
    }

    private render(): void {
        if (this.layout === null) return;

        this.resizeCanvas();
        const ctx = this.canvas.getContext('2d');
        if (ctx === null) return;

        const rect = this.canvas.getBoundingClientRect();
        ctx.clearRect(0, 0, rect.width, rect.height);

        // LOD: at low zoom we draw aggregated community super-nodes instead of
        // every individual one. 50 circles + a handful of inter-community
        // edges is constant-time render regardless of vault size.
        if (this.view.scale < COMMUNITY_AGGREGATE_ZOOM) {
            this.renderCommunityOverview(ctx);
            this.stats.textContent = `overview · ${this.layout.communities.length} communities · mod ${this.layout.modularity.toFixed(2)} · zoom ${this.view.scale.toFixed(2)}× (zoom in for nodes)`;
            return;
        }

        const visibleNodes = this.collectVisibleNodes(rect);

        if (this.view.scale >= EDGE_VISIBLE_ZOOM) {
            this.renderEdges(ctx, visibleNodes);
        }

        this.renderNodes(ctx, visibleNodes);

        if (this.view.scale >= LABEL_VISIBLE_ZOOM) {
            this.renderLabels(ctx, visibleNodes);
        }

        this.stats.textContent = `${this.layout.nodes.length} nodes · ${this.edges.length} edges · ${visibleNodes.size} visible · mod ${this.layout.modularity.toFixed(2)} · zoom ${this.view.scale.toFixed(2)}×`;
    }

    private renderCommunityOverview(ctx: CanvasRenderingContext2D): void {
        if (this.layout === null) return;

        // Inter-community edges first (thickness ∝ weight), so node circles overlap them.
        const maxWeight = Math.max(1, ...this.layout.interCommunityEdges.map((e) => e.weight));
        const communityById = new Map(this.layout.communities.map((c) => [c.id, c]));

        ctx.strokeStyle = 'rgba(140, 147, 164, 0.35)';

        for (const e of this.layout.interCommunityEdges) {
            const a = communityById.get(e.from);
            const b = communityById.get(e.to);
            if (a === undefined || b === undefined) continue;

            const pa = this.project(a.cx, a.cy);
            const pb = this.project(b.cx, b.cy);
            ctx.lineWidth = Math.max(0.5, (e.weight / maxWeight) * 4);
            ctx.beginPath();
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(pb.x, pb.y);
            ctx.stroke();
        }

        ctx.font = '11px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';

        for (const c of this.layout.communities) {
            const p = this.project(c.cx, c.cy);
            const r = Math.sqrt(c.size) * 8 + 6;

            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fillStyle = communityColor(c.id);
            ctx.globalAlpha = 0.7;
            ctx.fill();
            ctx.globalAlpha = 1;

            ctx.fillStyle = '#0b0d12';
            ctx.fillText(String(c.size), p.x, p.y);
        }

        ctx.textAlign = 'start';
    }

    private collectVisibleNodes(rect: DOMRect): Set<string> {
        const visible = new Set<string>();
        if (this.layout === null) return visible;

        const tagFilter = this.state.selectedTags;
        const margin = 40;

        for (const node of this.layout.nodes) {
            const fullNode = this.state.data.nodes.find((n) => n.id === node.id);
            if (fullNode === undefined) continue;

            if (tagFilter.size > 0 && !fullNode.tags.some((t) => tagFilter.has(t))) continue;

            const p = this.project(node.x, node.y);
            if (p.x < -margin || p.y < -margin || p.x > rect.width + margin || p.y > rect.height + margin) continue;

            visible.add(node.id);
        }

        return visible;
    }

    private renderEdges(ctx: CanvasRenderingContext2D, visible: Set<string>): void {
        ctx.lineWidth = Math.max(0.3, 0.6 * this.view.scale);
        ctx.strokeStyle = 'rgba(140, 147, 164, 0.18)';
        ctx.beginPath();

        for (const e of this.edges) {
            if (!visible.has(e.from) || !visible.has(e.to)) continue;
            const a = this.nodeIndex.get(e.from);
            const b = this.nodeIndex.get(e.to);
            if (a === undefined || b === undefined) continue;
            const pa = this.project(a.x, a.y);
            const pb = this.project(b.x, b.y);
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(pb.x, pb.y);
        }

        ctx.stroke();
    }

    private renderNodes(ctx: CanvasRenderingContext2D, visible: Set<string>): void {
        if (this.layout === null) return;
        const useCommunity = this.state.showCommunities;
        const showHeat = this.state.showHeat;

        for (const node of this.layout.nodes) {
            if (!visible.has(node.id)) continue;
            const p = this.project(node.x, node.y);
            const heat = showHeat ? (this.heatById.get(node.id) ?? 0) : 0;
            const r = NODE_BASE_RADIUS + Math.min(4, Math.sqrt(node.degree) * 0.5) + heat * 4;

            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fillStyle = useCommunity ? communityColor(node.community) : '#6c9aff';
            if (heat > 0) {
                ctx.shadowColor = '#fbbf24';
                ctx.shadowBlur = 8 * heat;
            }
            ctx.fill();
            ctx.shadowBlur = 0;

            if (node.id === this.hoverId) {
                ctx.lineWidth = 2;
                ctx.strokeStyle = '#f5f6f8';
                ctx.stroke();
            }
        }
    }

    private renderLabels(ctx: CanvasRenderingContext2D, visible: Set<string>): void {
        ctx.fillStyle = 'rgba(245, 246, 248, 0.85)';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textBaseline = 'middle';

        for (const node of this.state.data.nodes) {
            if (!visible.has(node.id)) continue;
            const layoutNode = this.nodeIndex.get(node.id);
            if (layoutNode === undefined) continue;
            const p = this.project(layoutNode.x, layoutNode.y);
            ctx.fillText(node.title, p.x + 6, p.y);
        }
    }
}