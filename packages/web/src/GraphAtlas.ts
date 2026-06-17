import type {Graph as GraphData} from '@synaipse/core';
import {api, type GraphLayout} from './Api.js';
import {communityColor} from './Communities.js';
import {el} from './Dom.js';
import type {EventKind} from './Events.js';
import type {GraphRenderer, GraphRendererCallbacks, GraphRendererState} from './GraphRenderer.js';

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
const EDGE_VISIBLE_ZOOM = 0.4;
const LABEL_VISIBLE_ZOOM = 1.2;

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
    private view: ViewState = {scale: 1, offsetX: 0, offsetY: 0};
    private rafHandle: number | null = null;
    private dragging = false;
    private dragLast: {x: number; y: number} | null = null;
    private hoverId: string | null = null;
    private heatById: ReadonlyMap<string, number> = new Map();
    private pendingFetch: Promise<void> | null = null;

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
        if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
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

        this.stats.textContent = 'computing layout…';

        this.pendingFetch = (async () => {
            try {
                this.layout = await api.getGraphLayout();
                this.edges = [...this.state.data.edges];
                this.nodeIndex = new Map(this.layout.nodes.map((n) => [n.id, n]));
                this.fitToContent();
            } catch (cause) {
                this.stats.textContent = `layout failed: ${String(cause)}`;
            } finally {
                this.pendingFetch = null;
                this.scheduleRender();
            }
        })();

        await this.pendingFetch;
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
        }, {passive: false});

        canvas.addEventListener('mousedown', (event) => {
            this.dragging = true;
            this.dragLast = {x: event.clientX, y: event.clientY};
        });

        window.addEventListener('mouseup', () => {
            this.dragging = false;
            this.dragLast = null;
        });

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
        });

        canvas.addEventListener('click', () => {
            if (this.hoverId !== null) this.cb.onSelectNote(this.hoverId);
        });

        const observer = new ResizeObserver(() => {
            this.resizeCanvas();
            this.scheduleRender();
        });
        observer.observe(this.element);
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
        if (this.layout === null) return null;
        const radius = (NODE_BASE_RADIUS + NODE_HIT_PADDING) / this.view.scale;
        const world = this.unproject(sx, sy);
        let best: {id: string; d: number} | null = null;

        for (const n of this.layout.nodes) {
            const dx = n.x - world.x;
            const dy = n.y - world.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > radius) continue;
            if (best === null || dist < best.d) best = {id: n.id, d: dist};
        }

        return best?.id ?? null;
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

        const visibleNodes = this.collectVisibleNodes(rect);
        this.stats.textContent = `${this.layout.nodes.length} nodes · ${this.edges.length} edges · ${visibleNodes.size} visible · mod ${this.layout.modularity.toFixed(2)} · zoom ${this.view.scale.toFixed(2)}×`;

        if (this.view.scale >= EDGE_VISIBLE_ZOOM) {
            this.renderEdges(ctx, visibleNodes);
        }

        this.renderNodes(ctx, visibleNodes);

        if (this.view.scale >= LABEL_VISIBLE_ZOOM) {
            this.renderLabels(ctx, visibleNodes);
        }
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