import type {CanvasDocument, CanvasEdge, CanvasNode, CanvasSide, CanvasTextNode} from '@synaipse/core';
import {api} from './Api.js';
import {clear, el} from './Dom.js';
import {renderMarkdownInto} from './MarkdownPreview.js';

const SIDES: readonly CanvasSide[] = ['top', 'right', 'bottom', 'left'];

const MIN_SCALE = 0.15;
const MAX_SCALE = 4;
const ZOOM_STEP = 1.15;
const MIN_CARD_W = 100;
const MIN_CARD_H = 60;
const DEFAULT_TEXT_CARD_W = 260;
const DEFAULT_TEXT_CARD_H = 140;

const COLOR_PRESETS: Readonly<Record<string, string>> = {
    '1': '#e56565',
    '2': '#e78e4f',
    '3': '#e7c34f',
    '4': '#5dbb63',
    '5': '#5aa9d4',
    '6': '#a06fc1'
};

/**
 * Obsidian's own color palette order — matches the swatches in Obsidian's
 * canvas UI so users transferring back and forth see the same visual
 * shorthand. Presets 1..6, followed by the "clear" pseudo-option.
 */
const COLOR_PRESET_ORDER: readonly string[] = ['1', '2', '3', '4', '5', '6'];

type ArrowStyle = 'to' | 'both' | 'none';

const arrowStyleOf = (edge: {fromEnd?: 'none' | 'arrow'; toEnd?: 'none' | 'arrow'}): ArrowStyle => {
    const from = edge.fromEnd === 'arrow';
    const to = edge.toEnd !== 'none';
    if (from && to) return 'both';
    if (!to) return 'none';
    return 'to';
};

const resolveColor = (raw: string | undefined, fallback: string): string => {
    if (raw === undefined) return fallback;
    return COLOR_PRESETS[raw] ?? raw;
};

/**
 * Short random ID. Obsidian uses 16-hex-char but any URL-safe string
 * survives round-trips through parseCanvas, so keep it simple.
 */
const genId = (): string => {
    const arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
};

interface AnchorPoint {
    x: number;
    y: number;
}

const anchorFor = (node: CanvasNode, side: CanvasSide | undefined, other: CanvasNode): AnchorPoint => {
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;

    if (side === 'top') return {x: cx, y: node.y};
    if (side === 'bottom') return {x: cx, y: node.y + node.height};
    if (side === 'left') return {x: node.x, y: cy};
    if (side === 'right') return {x: node.x + node.width, y: cy};

    const ox = other.x + other.width / 2;
    const oy = other.y + other.height / 2;
    const dx = ox - cx;
    const dy = oy - cy;

    if (Math.abs(dx) > Math.abs(dy)) {
        return dx > 0
            ? {x: node.x + node.width, y: cy}
            : {x: node.x, y: cy};
    }
    return dy > 0
        ? {x: cx, y: node.y + node.height}
        : {x: cx, y: node.y};
};

export interface CanvasRendererOptions {
    onOpenNote: (noteId: string) => void;
    onOpenLink: (url: string) => void;
    /**
     * Fires whenever the underlying document mutates (drag drop, resize,
     * add/delete card, text commit). CanvasPanel debounces persistence.
     */
    onChange?: (doc: CanvasDocument) => void;
    editable?: boolean;
}

type DragMode = 'move' | 'resize';

interface DragState {
    id: string;
    mode: DragMode;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
    startClientX: number;
    startClientY: number;
    moved: boolean;
}

/**
 * "User is drawing a new edge from a source anchor." The draft has no
 * commitment to the vault doc yet — only when the pointer is released
 * over another card does an edge with a fresh id get pushed and saved.
 */
interface EdgeDraftState {
    fromNode: string;
    fromSide: CanvasSide;
    currentWorldX: number;
    currentWorldY: number;
}

/**
 * "User is dragging one endpoint of an existing selected edge." Same
 * resolve-target-card-on-release semantics as EdgeDraftState, but on
 * commit we rewrite the endpoint rather than push a new edge.
 */
interface EdgeHandleDragState {
    edgeId: string;
    endpoint: 'from' | 'to';
    currentWorldX: number;
    currentWorldY: number;
}

/**
 * "User is Shift-dragging on empty stage to define a new group node."
 * The rubber-band rect lives inside `stage` (so it inherits pan/zoom)
 * and normalises min/max on release so drags in any direction produce
 * a positive-area rectangle.
 */
interface BandSelectState {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
}

export class CanvasRenderer {
    public readonly element: HTMLElement;
    private stage!: HTMLElement;
    private edgesSvg!: SVGSVGElement;
    private cardsHost!: HTMLElement;
    private groupsHost!: HTMLElement;
    private scale = 1;
    private tx = 0;
    private ty = 0;

    private panning = false;
    private panStartX = 0;
    private panStartY = 0;
    private panStartTx = 0;
    private panStartTy = 0;

    private doc: CanvasDocument;
    private cardEls = new Map<string, HTMLElement>();
    private selectedId: string | null = null;
    private selectedEdgeId: string | null = null;
    private editingId: string | null = null;
    private dragState: DragState | null = null;
    private edgeDraft: EdgeDraftState | null = null;
    private edgeHandleDrag: EdgeHandleDragState | null = null;
    private bandSelect: BandSelectState | null = null;
    private bandRectEl: HTMLElement | null = null;
    private edgeToolbar: HTMLElement | null = null;

    private onKeyDown = (event: KeyboardEvent): void => {
        if (!this.editable) return;
        if (!this.element.isConnected) return;
        if (this.editingId !== null) return; // typing in textarea
        if (event.key !== 'Delete' && event.key !== 'Backspace') return;

        // Guard against removing while the user was typing in an
        // unrelated input elsewhere on the page.
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;

        if (this.selectedEdgeId !== null) {
            event.preventDefault();
            this.removeEdge(this.selectedEdgeId);
            return;
        }

        if (this.selectedId !== null) {
            event.preventDefault();
            this.removeNode(this.selectedId);
        }
    };

    public constructor(doc: CanvasDocument, private readonly opts: CanvasRendererOptions) {
        this.doc = doc;
        this.element = el('div', {class: 'canvas-viewport', attrs: {tabindex: '0'}});
        this.build();
    }

    private get editable(): boolean {
        return this.opts.editable !== false;
    }

    public mount(): void {
        this.fitView();
    }

    public destroy(): void {
        document.removeEventListener('keydown', this.onKeyDown);
        this.destroyEdgeToolbar();
    }

    /** Current document — CanvasPanel reads this to persist. */
    public getDoc(): CanvasDocument {
        return this.doc;
    }

    private build(): void {
        this.groupsHost = el('div', {class: 'canvas-groups'});
        this.cardsHost = el('div', {class: 'canvas-cards'});
        this.edgesSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.edgesSvg.classList.add('canvas-edges');
        this.edgesSvg.setAttribute('overflow', 'visible');

        this.stage = el('div', {class: 'canvas-stage'});
        this.stage.appendChild(this.groupsHost);
        this.stage.appendChild(this.edgesSvg);
        this.stage.appendChild(this.cardsHost);

        this.element.appendChild(this.stage);

        this.element.addEventListener('wheel', this.onWheel, {passive: false});
        this.element.addEventListener('pointerdown', this.onPointerDown);
        this.element.addEventListener('pointermove', this.onPointerMove);
        this.element.addEventListener('pointerup', this.onPointerUp);
        this.element.addEventListener('pointercancel', this.onPointerUp);
        this.element.addEventListener('dblclick', this.onDoubleClick);
        document.addEventListener('keydown', this.onKeyDown);

        this.renderAll();
    }

    private renderAll(): void {
        this.renderGroups();
        this.renderCards();
        this.renderEdges();
    }

    private renderGroups(): void {
        clear(this.groupsHost);

        for (const node of this.doc.nodes) {
            if (node.type !== 'group') continue;

            const border = resolveColor(node.color, 'rgba(255,255,255,0.18)');
            const rect = el('div', {
                class: 'canvas-group',
                style: {
                    left: `${node.x}px`,
                    top: `${node.y}px`,
                    width: `${node.width}px`,
                    height: `${node.height}px`,
                    borderColor: border
                }
            });
            rect.dataset.nodeId = node.id;

            if (node.label !== undefined && node.label.length > 0) {
                rect.appendChild(el('div', {
                    class: 'canvas-group-label',
                    style: {color: border},
                    text: node.label
                }));
            }

            this.groupsHost.appendChild(rect);
        }
    }

    private renderCards(): void {
        clear(this.cardsHost);
        this.cardEls.clear();

        for (const node of this.doc.nodes) {
            if (node.type === 'group') continue;
            const card = this.buildCard(node);
            this.cardsHost.appendChild(card);
            this.cardEls.set(node.id, card);
        }
    }

    private buildCard(node: CanvasNode): HTMLElement {
        const card = el('div', {
            class: `canvas-card canvas-card-${node.type}`,
            style: {
                left: `${node.x}px`,
                top: `${node.y}px`,
                width: `${node.width}px`,
                height: `${node.height}px`
            }
        });
        card.dataset.nodeId = node.id;

        const accent = resolveColor(node.color, '');
        if (accent.length > 0) {
            card.style.borderColor = accent;
            card.style.boxShadow = `inset 3px 0 0 ${accent}`;
        }

        if (node.id === this.selectedId) card.classList.add('selected');

        if (node.type === 'text') {
            const body = el('div', {class: 'canvas-card-body md-preview'});
            body.dataset.role = 'text-body';
            renderMarkdownInto(body, node.text);
            card.appendChild(body);
        } else if (node.type === 'file') {
            this.populateFileCard(card, node.file);
        } else if (node.type === 'link') {
            card.appendChild(el('div', {class: 'canvas-card-link'},
                el('a', {
                    attrs: {href: node.url, target: '_blank', rel: 'noopener noreferrer'},
                    text: node.url,
                    on: {click: (e) => {
                        e.preventDefault();
                        this.opts.onOpenLink(node.url);
                    }}
                })
            ));
        }

        if (this.editable) {
            const handle = el('div', {class: 'canvas-card-resize', attrs: {title: 'Resize'}});
            handle.dataset.role = 'resize';
            card.appendChild(handle);

            // One anchor dot per card side. Purely visual (positioned via
            // CSS); the pointer handler routes based on data-role='anchor'
            // + data-side. Group nodes stay anchor-less — edges only
            // connect real cards, matching Obsidian's rules.
            for (const side of SIDES) {
                const anchor = el('div', {
                    class: `canvas-card-anchor canvas-card-anchor-${side}`,
                    attrs: {title: `Drag to create edge (${side})`}
                });
                anchor.dataset.role = 'anchor';
                anchor.dataset.side = side;
                card.appendChild(anchor);
            }
        }

        return card;
    }

    private populateFileCard(card: HTMLElement, fileId: string): void {
        const title = el('div', {class: 'canvas-card-file-title', text: fileId});
        const preview = el('div', {class: 'canvas-card-file-preview', text: 'loading…'});

        card.appendChild(title);
        card.appendChild(preview);
        card.classList.add('canvas-card-clickable');

        void api.getNote(fileId).then((note) => {
            title.textContent = note.title;
            const snippet = note.content.slice(0, 320);
            preview.textContent = snippet + (note.content.length > 320 ? '…' : '');
        }).catch(() => {
            preview.textContent = '(note not found in vault)';
            preview.classList.add('canvas-card-file-missing');
        });
    }

    private renderEdges(): void {
        clear(this.edgesSvg);

        const bounds = this.computeBounds();
        const width = bounds.maxX - bounds.minX + 200;
        const height = bounds.maxY - bounds.minY + 200;
        this.edgesSvg.setAttribute('viewBox', `${bounds.minX - 100} ${bounds.minY - 100} ${width} ${height}`);
        this.edgesSvg.style.left = `${bounds.minX - 100}px`;
        this.edgesSvg.style.top = `${bounds.minY - 100}px`;
        this.edgesSvg.style.width = `${width}px`;
        this.edgesSvg.style.height = `${height}px`;

        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        marker.setAttribute('id', 'canvas-arrow');
        marker.setAttribute('viewBox', '0 0 10 10');
        marker.setAttribute('refX', '9');
        marker.setAttribute('refY', '5');
        marker.setAttribute('markerWidth', '6');
        marker.setAttribute('markerHeight', '6');
        marker.setAttribute('orient', 'auto-start-reverse');
        const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        arrow.setAttribute('d', 'M0,0 L10,5 L0,10 z');
        arrow.setAttribute('fill', 'currentColor');
        marker.appendChild(arrow);
        defs.appendChild(marker);
        this.edgesSvg.appendChild(defs);

        const nodesById = new Map(this.doc.nodes.map((n) => [n.id, n]));

        for (const edge of this.doc.edges) {
            const from = nodesById.get(edge.fromNode);
            const to = nodesById.get(edge.toNode);
            if (from === undefined || to === undefined) continue;
            if (from.type === 'group' || to.type === 'group') continue;

            // If this edge's endpoint is being dragged, use the live cursor
            // position instead of the stored anchor so the line follows
            // the pointer during the reroute drag.
            const dragging = this.edgeHandleDrag !== null && this.edgeHandleDrag.edgeId === edge.id
                ? this.edgeHandleDrag
                : null;

            const a = dragging?.endpoint === 'from'
                ? {x: dragging.currentWorldX, y: dragging.currentWorldY}
                : anchorFor(from, edge.fromSide, to);
            const b = dragging?.endpoint === 'to'
                ? {x: dragging.currentWorldX, y: dragging.currentWorldY}
                : anchorFor(to, edge.toSide, from);
            const color = resolveColor(edge.color, 'var(--accent)');
            const isSelected = edge.id === this.selectedEdgeId;

            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.classList.add('canvas-edge-group');
            if (isSelected) group.classList.add('selected');
            group.dataset.edgeId = edge.id;

            // Invisible thick line sits under the visible one so the click
            // hitbox is easy to hit even at ~2px stroke widths.
            const hitbox = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            hitbox.setAttribute('x1', String(a.x));
            hitbox.setAttribute('y1', String(a.y));
            hitbox.setAttribute('x2', String(b.x));
            hitbox.setAttribute('y2', String(b.y));
            hitbox.setAttribute('stroke', 'transparent');
            hitbox.setAttribute('stroke-width', '16');
            hitbox.setAttribute('pointer-events', 'stroke');
            hitbox.classList.add('canvas-edge-hitbox');
            group.appendChild(hitbox);

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', String(a.x));
            line.setAttribute('y1', String(a.y));
            line.setAttribute('x2', String(b.x));
            line.setAttribute('y2', String(b.y));
            line.setAttribute('stroke', color);
            line.setAttribute('stroke-width', isSelected ? '3' : '2');
            line.setAttribute('pointer-events', 'none');
            line.style.color = color;
            if (edge.toEnd !== 'none') {
                line.setAttribute('marker-end', 'url(#canvas-arrow)');
            }
            if (edge.fromEnd === 'arrow') {
                line.setAttribute('marker-start', 'url(#canvas-arrow)');
            }
            line.classList.add('canvas-edge');
            group.appendChild(line);

            if (edge.label !== undefined && edge.label.length > 0) {
                const midX = (a.x + b.x) / 2;
                const midY = (a.y + b.y) / 2;
                const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                text.setAttribute('x', String(midX));
                text.setAttribute('y', String(midY - 6));
                text.setAttribute('text-anchor', 'middle');
                text.setAttribute('fill', color);
                text.setAttribute('font-size', '12');
                text.setAttribute('pointer-events', 'none');
                text.textContent = edge.label;
                group.appendChild(text);
            }

            this.edgesSvg.appendChild(group);

            // Endpoint handles appear ONLY on the selected edge. They stack
            // on top of the arrow marker so the user can grab either end
            // even when it terminates near a card.
            if (isSelected && this.editable) {
                for (const endpoint of ['from', 'to'] as const) {
                    const p = endpoint === 'from' ? a : b;
                    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    dot.setAttribute('cx', String(p.x));
                    dot.setAttribute('cy', String(p.y));
                    dot.setAttribute('r', '6');
                    dot.classList.add('canvas-edge-handle');
                    dot.dataset.edgeId = edge.id;
                    dot.dataset.endpoint = endpoint;
                    this.edgesSvg.appendChild(dot);
                }
            }
        }

        // Toolbar position tracks whatever midpoint the just-rendered
        // geometry produced — a card drag / handle drag / reroute all
        // funnel through renderEdges, so this is the single hook that
        // keeps the floating toolbar aligned.
        this.updateEdgeToolbarPosition();

        // Draft edge — either a brand-new one being drawn from an anchor,
        // or the ghost of a selected edge's endpoint being rerouted.
        if (this.edgeDraft !== null) {
            const from = nodesById.get(this.edgeDraft.fromNode);
            if (from !== undefined && from.type !== 'group') {
                const start = anchorFor(from, this.edgeDraft.fromSide, {
                    x: this.edgeDraft.currentWorldX,
                    y: this.edgeDraft.currentWorldY,
                    width: 0,
                    height: 0,
                    id: '__cursor__',
                    type: 'text',
                    text: ''
                });
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                line.setAttribute('x1', String(start.x));
                line.setAttribute('y1', String(start.y));
                line.setAttribute('x2', String(this.edgeDraft.currentWorldX));
                line.setAttribute('y2', String(this.edgeDraft.currentWorldY));
                line.classList.add('canvas-edge-draft');
                line.setAttribute('pointer-events', 'none');
                this.edgesSvg.appendChild(line);
            }
        }
    }

    private computeBounds(): {minX: number; minY: number; maxX: number; maxY: number} {
        if (this.doc.nodes.length === 0) {
            return {minX: 0, minY: 0, maxX: 800, maxY: 600};
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const n of this.doc.nodes) {
            if (n.x < minX) minX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.x + n.width > maxX) maxX = n.x + n.width;
            if (n.y + n.height > maxY) maxY = n.y + n.height;
        }
        return {minX, minY, maxX, maxY};
    }

    private fitView(): void {
        const bounds = this.computeBounds();
        const contentW = bounds.maxX - bounds.minX;
        const contentH = bounds.maxY - bounds.minY;
        const viewW = this.element.clientWidth || 1200;
        const viewH = this.element.clientHeight || 800;

        if (contentW <= 0 || contentH <= 0) {
            this.applyTransform();
            return;
        }

        const scaleX = (viewW * 0.9) / contentW;
        const scaleY = (viewH * 0.9) / contentH;
        this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(scaleX, scaleY)));

        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerY = (bounds.minY + bounds.maxY) / 2;
        this.tx = viewW / 2 - centerX * this.scale;
        this.ty = viewH / 2 - centerY * this.scale;

        this.applyTransform();
    }

    private applyTransform(): void {
        this.stage.style.transform = `translate3d(${this.tx}px, ${this.ty}px, 0) scale(${this.scale})`;
        this.updateEdgeToolbarPosition();
    }

    // ─── Selection ───

    /**
     * Cards and edges have mutually exclusive selection state — a keypress
     * needs a single "delete the currently focused thing" target, and
     * showing endpoint handles on an edge while a card is also outlined is
     * confusing. Both helpers no-op when nothing changes.
     */
    private selectCard(id: string | null): void {
        if (this.selectedEdgeId !== null) {
            this.selectedEdgeId = null;
            this.renderEdges();
        }
        if (this.selectedId === id) return;
        if (this.selectedId !== null) {
            this.cardEls.get(this.selectedId)?.classList.remove('selected');
        }
        this.selectedId = id;
        if (id !== null) {
            this.cardEls.get(id)?.classList.add('selected');
        }
    }

    private selectEdge(id: string | null): void {
        if (this.selectedId !== null) {
            this.cardEls.get(this.selectedId)?.classList.remove('selected');
            this.selectedId = null;
        }
        if (this.selectedEdgeId === id) return;
        this.selectedEdgeId = id;
        this.renderEdges();
        this.refreshEdgeToolbar();
    }

    /**
     * Rebuild the floating edge toolbar to reflect the current selection:
     * when no edge is selected, the toolbar is destroyed; when the same
     * edge stays selected (e.g. after a color change) the DOM is patched
     * in place so the active-state highlight tracks the new attrs.
     */
    private refreshEdgeToolbar(): void {
        if (this.selectedEdgeId === null) {
            this.destroyEdgeToolbar();
            return;
        }
        const edge = this.doc.edges.find((e) => e.id === this.selectedEdgeId);
        if (edge === undefined) {
            this.destroyEdgeToolbar();
            return;
        }
        if (this.edgeToolbar === null) {
            this.edgeToolbar = this.buildEdgeToolbar(edge.id);
            this.element.appendChild(this.edgeToolbar);
        } else {
            // Same edge, refresh contents.
            clear(this.edgeToolbar);
            this.populateEdgeToolbar(this.edgeToolbar, edge.id);
        }
        this.updateEdgeToolbarPosition();
    }

    private destroyEdgeToolbar(): void {
        if (this.edgeToolbar !== null) {
            this.edgeToolbar.remove();
            this.edgeToolbar = null;
        }
    }

    private buildEdgeToolbar(edgeId: string): HTMLElement {
        const bar = el('div', {class: 'canvas-edge-toolbar'});
        this.populateEdgeToolbar(bar, edgeId);
        return bar;
    }

    private populateEdgeToolbar(bar: HTMLElement, edgeId: string): void {
        const edge = this.doc.edges.find((e) => e.id === edgeId);
        if (edge === undefined) return;

        for (const preset of COLOR_PRESET_ORDER) {
            const swatch = el('button', {
                class: edge.color === preset
                    ? 'canvas-edge-swatch active'
                    : 'canvas-edge-swatch',
                attrs: {type: 'button', title: `Color ${preset}`, 'aria-label': `Color ${preset}`},
                style: {background: COLOR_PRESETS[preset] ?? '#888'},
                on: {click: (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    this.setEdgeColor(edgeId, preset);
                }}
            });
            bar.appendChild(swatch);
        }

        bar.appendChild(el('button', {
            class: edge.color === undefined
                ? 'canvas-edge-swatch canvas-edge-swatch-clear active'
                : 'canvas-edge-swatch canvas-edge-swatch-clear',
            attrs: {type: 'button', title: 'Clear color', 'aria-label': 'Clear color'},
            text: '∅',
            on: {click: (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this.setEdgeColor(edgeId, undefined);
            }}
        }));

        bar.appendChild(el('div', {class: 'canvas-edge-toolbar-sep'}));

        const currentStyle = arrowStyleOf(edge);
        const arrowBtn = (style: ArrowStyle, label: string, title: string): HTMLElement => el('button', {
            class: currentStyle === style
                ? 'canvas-edge-arrow-btn active'
                : 'canvas-edge-arrow-btn',
            attrs: {type: 'button', title, 'aria-label': title},
            text: label,
            on: {click: (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this.setEdgeArrow(edgeId, style);
            }}
        });
        bar.appendChild(arrowBtn('to', '→', 'Arrow at target only'));
        bar.appendChild(arrowBtn('both', '↔', 'Arrows at both ends'));
        bar.appendChild(arrowBtn('none', '—', 'No arrows'));
    }

    private updateEdgeToolbarPosition(): void {
        if (this.edgeToolbar === null || this.selectedEdgeId === null) return;
        const edge = this.doc.edges.find((e) => e.id === this.selectedEdgeId);
        if (edge === undefined) return;
        const from = this.nodeById(edge.fromNode);
        const to = this.nodeById(edge.toNode);
        if (from === undefined || to === undefined) return;
        if (from.type === 'group' || to.type === 'group') return;

        const a = anchorFor(from, edge.fromSide, to);
        const b = anchorFor(to, edge.toSide, from);
        // World midpoint → screen coords via current pan/zoom.
        const midWorldX = (a.x + b.x) / 2;
        const midWorldY = (a.y + b.y) / 2;
        const screenX = midWorldX * this.scale + this.tx;
        const screenY = midWorldY * this.scale + this.ty;
        this.edgeToolbar.style.left = `${screenX}px`;
        this.edgeToolbar.style.top = `${screenY - 42}px`;
    }

    private setEdgeColor(edgeId: string, preset: string | undefined): void {
        const idx = this.doc.edges.findIndex((e) => e.id === edgeId);
        if (idx === -1) return;
        const current = this.doc.edges[idx];
        if (current === undefined) return;
        const patched = {...current};
        if (preset === undefined) {
            delete patched.color;
        } else {
            patched.color = preset;
        }
        const nextEdges = this.doc.edges.slice();
        nextEdges[idx] = patched;
        this.doc = {nodes: this.doc.nodes, edges: nextEdges};
        this.renderEdges();
        this.refreshEdgeToolbar();
        this.commit();
    }

    private setEdgeArrow(edgeId: string, style: ArrowStyle): void {
        const idx = this.doc.edges.findIndex((e) => e.id === edgeId);
        if (idx === -1) return;
        const current = this.doc.edges[idx];
        if (current === undefined) return;
        const patched = {...current};
        if (style === 'to') {
            patched.toEnd = 'arrow';
            delete patched.fromEnd;
        } else if (style === 'both') {
            patched.toEnd = 'arrow';
            patched.fromEnd = 'arrow';
        } else {
            patched.toEnd = 'none';
            delete patched.fromEnd;
        }
        const nextEdges = this.doc.edges.slice();
        nextEdges[idx] = patched;
        this.doc = {nodes: this.doc.nodes, edges: nextEdges};
        this.renderEdges();
        this.refreshEdgeToolbar();
        this.commit();
    }

    // ─── Mutations ───

    private commit(): void {
        this.opts.onChange?.(this.doc);
    }

    private nodeById(id: string): CanvasNode | undefined {
        return this.doc.nodes.find((n) => n.id === id);
    }

    private removeNode(id: string): void {
        this.doc = {
            nodes: this.doc.nodes.filter((n) => n.id !== id),
            edges: this.doc.edges.filter((e) => e.fromNode !== id && e.toNode !== id)
        };
        if (this.selectedId === id) this.selectedId = null;
        this.renderAll();
        this.commit();
    }

    private removeEdge(id: string): void {
        this.doc = {
            nodes: this.doc.nodes,
            edges: this.doc.edges.filter((e) => e.id !== id)
        };
        if (this.selectedEdgeId === id) this.selectedEdgeId = null;
        this.renderEdges();
        this.commit();
    }

    private addEdge(fromNode: string, fromSide: CanvasSide, toNode: string): CanvasEdge {
        // No self-loops. Silently drop rather than error — the user just
        // dragged onto the same card, no need to interrupt with a modal.
        // Also drop if an edge with the same endpoints already exists so
        // repeated drags don't stack duplicates.
        const edge: CanvasEdge = {
            id: genId(),
            fromNode,
            toNode,
            fromSide,
            toEnd: 'arrow'
        };
        this.doc = {
            nodes: this.doc.nodes,
            edges: [...this.doc.edges, edge]
        };
        return edge;
    }

    private rerouteEdge(edgeId: string, endpoint: 'from' | 'to', newNode: string): void {
        const idx = this.doc.edges.findIndex((e) => e.id === edgeId);
        if (idx === -1) return;
        const current = this.doc.edges[idx];
        if (current === undefined) return;
        // Self-loops silently rejected (same reason as addEdge).
        if (endpoint === 'from' && newNode === current.toNode) return;
        if (endpoint === 'to' && newNode === current.fromNode) return;

        const next: CanvasEdge = endpoint === 'from'
            ? {...current, fromNode: newNode}
            : {...current, toNode: newNode};

        const nextEdges = this.doc.edges.slice();
        nextEdges[idx] = next;
        this.doc = {nodes: this.doc.nodes, edges: nextEdges};
    }

    private updateBandRect(): void {
        if (this.bandSelect === null || this.bandRectEl === null) return;
        const {startWorldX, startWorldY, currentWorldX, currentWorldY} = this.bandSelect;
        const minX = Math.min(startWorldX, currentWorldX);
        const minY = Math.min(startWorldY, currentWorldY);
        const width = Math.abs(currentWorldX - startWorldX);
        const height = Math.abs(currentWorldY - startWorldY);
        this.bandRectEl.style.left = `${minX}px`;
        this.bandRectEl.style.top = `${minY}px`;
        this.bandRectEl.style.width = `${width}px`;
        this.bandRectEl.style.height = `${height}px`;
    }

    private addGroup(x: number, y: number, width: number, height: number): string {
        const id = genId();
        const node = {
            id,
            type: 'group' as const,
            x,
            y,
            width,
            height,
            label: ''
        };
        this.doc = {nodes: [...this.doc.nodes, node], edges: this.doc.edges};
        this.renderAll();
        this.commit();
        return id;
    }

    public addTextCard(worldX: number, worldY: number, text = ''): string {
        const id = genId();
        const node: CanvasTextNode = {
            id,
            type: 'text',
            x: Math.round(worldX - DEFAULT_TEXT_CARD_W / 2),
            y: Math.round(worldY - DEFAULT_TEXT_CARD_H / 2),
            width: DEFAULT_TEXT_CARD_W,
            height: DEFAULT_TEXT_CARD_H,
            text
        };
        this.doc = {nodes: [...this.doc.nodes, node], edges: this.doc.edges};
        this.renderAll();
        this.selectCard(id);
        this.commit();
        return id;
    }

    /** Convert page coords into stage/world coords. */
    private toWorld(clientX: number, clientY: number): {x: number; y: number} {
        const rect = this.element.getBoundingClientRect();
        return {
            x: (clientX - rect.left - this.tx) / this.scale,
            y: (clientY - rect.top - this.ty) / this.scale
        };
    }

    /**
     * elementFromPoint the pointer position, walk up to a `.canvas-card`,
     * return its node id — unless it equals `skipNodeId` (used to reject
     * self-loops in both edge-create and edge-reroute). Group nodes are
     * intentionally skipped because edges only connect real cards.
     */
    private resolveTargetNodeId(clientX: number, clientY: number, skipNodeId: string): string | null {
        const el = document.elementFromPoint(clientX, clientY);
        if (el === null) return null;
        const cardEl = (el as HTMLElement).closest('.canvas-card') as HTMLElement | null;
        if (cardEl === null) return null;
        const id = cardEl.dataset.nodeId;
        if (id === undefined || id === skipNodeId) return null;
        const node = this.nodeById(id);
        if (node === undefined || node.type === 'group') return null;
        return id;
    }

    // ─── Text-card inline editing ───

    private startTextEdit(id: string, body: HTMLElement): void {
        if (this.editingId === id) return;
        this.editingId = id;

        const node = this.nodeById(id);
        if (node === undefined || node.type !== 'text') return;

        clear(body);
        const textarea = document.createElement('textarea');
        textarea.className = 'canvas-card-edit';
        textarea.value = node.text;
        textarea.spellcheck = false;
        body.appendChild(textarea);
        textarea.focus();
        // Move caret to end so the user can continue typing on new cards.
        textarea.selectionStart = textarea.value.length;
        textarea.selectionEnd = textarea.value.length;

        const commit = (): void => {
            const nextText = textarea.value;
            this.editingId = null;
            const idx = this.doc.nodes.findIndex((n) => n.id === id);
            if (idx === -1) return;
            const current = this.doc.nodes[idx];
            if (current !== undefined && current.type === 'text') {
                const changed = current.text !== nextText;
                if (changed) {
                    const nextNodes = this.doc.nodes.slice();
                    nextNodes[idx] = {...current, text: nextText};
                    this.doc = {nodes: nextNodes, edges: this.doc.edges};
                }
                clear(body);
                renderMarkdownInto(body, nextText);
                if (changed) this.commit();
            }
        };

        textarea.addEventListener('blur', commit);
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                commit();
            }
        });
    }

    // ─── Pointer handling ───

    private onWheel = (event: WheelEvent): void => {
        event.preventDefault();

        const rect = this.element.getBoundingClientRect();
        const cx = event.clientX - rect.left;
        const cy = event.clientY - rect.top;

        const worldX = (cx - this.tx) / this.scale;
        const worldY = (cy - this.ty) / this.scale;

        const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * factor));

        this.tx = cx - worldX * nextScale;
        this.ty = cy - worldY * nextScale;
        this.scale = nextScale;

        this.applyTransform();
    };

    private onPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0) return;

        const target = event.target as HTMLElement | SVGElement;

        // Textareas: let the browser handle the click normally.
        if (target.tagName === 'TEXTAREA') return;
        // Links inside cards: let them be clicked normally.
        if (target.tagName === 'A') return;

        // ── Edge-first: an anchor dot beats the card behind it, an edge
        //     handle beats the edge behind it, an edge beats an empty
        //     background.
        if (this.editable && target instanceof HTMLElement && target.dataset.role === 'anchor') {
            const cardEl = target.closest('.canvas-card') as HTMLElement | null;
            const fromNode = cardEl?.dataset.nodeId;
            const side = target.dataset.side as CanvasSide | undefined;
            if (fromNode !== undefined && side !== undefined) {
                const {x, y} = this.toWorld(event.clientX, event.clientY);
                this.edgeDraft = {fromNode, fromSide: side, currentWorldX: x, currentWorldY: y};
                this.element.classList.add('edge-drafting');
                this.element.setPointerCapture(event.pointerId);
                this.renderEdges();
                return;
            }
        }

        if (this.editable && target instanceof SVGElement && target.classList.contains('canvas-edge-handle')) {
            const edgeId = target.dataset.edgeId;
            const endpoint = target.dataset.endpoint as 'from' | 'to' | undefined;
            if (edgeId !== undefined && (endpoint === 'from' || endpoint === 'to')) {
                const {x, y} = this.toWorld(event.clientX, event.clientY);
                this.edgeHandleDrag = {edgeId, endpoint, currentWorldX: x, currentWorldY: y};
                this.element.classList.add('edge-drafting');
                this.element.setPointerCapture(event.pointerId);
                this.renderEdges();
                return;
            }
        }

        if (target instanceof SVGElement) {
            const edgeGroup = target.closest('.canvas-edge-group') as SVGGElement | null;
            if (edgeGroup !== null) {
                const edgeId = edgeGroup.dataset.edgeId;
                if (edgeId !== undefined) {
                    this.selectEdge(edgeId);
                    return;
                }
            }
        }

        const targetEl = target instanceof HTMLElement ? target : null;
        const cardEl = targetEl?.closest('.canvas-card') as HTMLElement | null ?? null;
        const isResizeHandle = targetEl?.dataset.role === 'resize';

        if (cardEl !== null && this.editable) {
            const id = cardEl.dataset.nodeId;
            if (id === undefined) return;
            const node = this.nodeById(id);
            if (node === undefined) return;

            this.selectCard(id);

            // Never drag while inline text edit is active on this card.
            if (this.editingId === id) return;

            this.dragState = {
                id,
                mode: isResizeHandle ? 'resize' : 'move',
                origX: node.x,
                origY: node.y,
                origW: node.width,
                origH: node.height,
                startClientX: event.clientX,
                startClientY: event.clientY,
                moved: false
            };
            this.element.setPointerCapture(event.pointerId);
            return;
        }

        // Empty background — deselect + either group-band-select (Shift)
        // or pan (default).
        this.selectCard(null);
        this.selectEdge(null);

        if (this.editable && event.shiftKey) {
            const {x, y} = this.toWorld(event.clientX, event.clientY);
            this.bandSelect = {
                startWorldX: x,
                startWorldY: y,
                currentWorldX: x,
                currentWorldY: y
            };
            this.bandRectEl = el('div', {class: 'canvas-band-rect'});
            this.stage.appendChild(this.bandRectEl);
            this.updateBandRect();
            this.element.setPointerCapture(event.pointerId);
            return;
        }

        this.panning = true;
        this.panStartX = event.clientX;
        this.panStartY = event.clientY;
        this.panStartTx = this.tx;
        this.panStartTy = this.ty;
        this.element.classList.add('panning');
        this.element.setPointerCapture(event.pointerId);
    };

    private onPointerMove = (event: PointerEvent): void => {
        if (this.bandSelect !== null) {
            const {x, y} = this.toWorld(event.clientX, event.clientY);
            this.bandSelect.currentWorldX = x;
            this.bandSelect.currentWorldY = y;
            this.updateBandRect();
            return;
        }

        if (this.edgeDraft !== null) {
            const {x, y} = this.toWorld(event.clientX, event.clientY);
            this.edgeDraft.currentWorldX = x;
            this.edgeDraft.currentWorldY = y;
            this.renderEdges();
            return;
        }

        if (this.edgeHandleDrag !== null) {
            const {x, y} = this.toWorld(event.clientX, event.clientY);
            this.edgeHandleDrag.currentWorldX = x;
            this.edgeHandleDrag.currentWorldY = y;
            this.renderEdges();
            return;
        }

        if (this.dragState !== null) {
            const dx = (event.clientX - this.dragState.startClientX) / this.scale;
            const dy = (event.clientY - this.dragState.startClientY) / this.scale;

            if (!this.dragState.moved && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) {
                this.dragState.moved = true;
            }

            const node = this.nodeById(this.dragState.id);
            if (node === undefined) return;

            const card = this.cardEls.get(this.dragState.id);
            if (card === undefined) return;

            if (this.dragState.mode === 'move') {
                node.x = Math.round(this.dragState.origX + dx);
                node.y = Math.round(this.dragState.origY + dy);
                card.style.left = `${node.x}px`;
                card.style.top = `${node.y}px`;
            } else {
                node.width = Math.max(MIN_CARD_W, Math.round(this.dragState.origW + dx));
                node.height = Math.max(MIN_CARD_H, Math.round(this.dragState.origH + dy));
                card.style.width = `${node.width}px`;
                card.style.height = `${node.height}px`;
            }

            this.renderEdges();
            return;
        }

        if (this.panning) {
            this.tx = this.panStartTx + (event.clientX - this.panStartX);
            this.ty = this.panStartTy + (event.clientY - this.panStartY);
            this.applyTransform();
        }
    };

    private onPointerUp = (event: PointerEvent): void => {
        if (this.bandSelect !== null) {
            const band = this.bandSelect;
            this.bandSelect = null;
            if (this.bandRectEl !== null) {
                this.bandRectEl.remove();
                this.bandRectEl = null;
            }
            if (this.element.hasPointerCapture(event.pointerId)) {
                this.element.releasePointerCapture(event.pointerId);
            }

            const minX = Math.min(band.startWorldX, band.currentWorldX);
            const minY = Math.min(band.startWorldY, band.currentWorldY);
            const width = Math.abs(band.currentWorldX - band.startWorldX);
            const height = Math.abs(band.currentWorldY - band.startWorldY);

            // Rubber-bands smaller than this are usually accidental Shift-clicks;
            // dropping them avoids spawning zero-size group nodes.
            const MIN_GROUP_SIZE = 40;
            if (width >= MIN_GROUP_SIZE && height >= MIN_GROUP_SIZE) {
                this.addGroup(Math.round(minX), Math.round(minY), Math.round(width), Math.round(height));
            }
            return;
        }

        if (this.edgeDraft !== null) {
            const draft = this.edgeDraft;
            this.edgeDraft = null;
            this.element.classList.remove('edge-drafting');
            if (this.element.hasPointerCapture(event.pointerId)) {
                this.element.releasePointerCapture(event.pointerId);
            }

            const targetNodeId = this.resolveTargetNodeId(event.clientX, event.clientY, draft.fromNode);
            if (targetNodeId !== null) {
                const edge = this.addEdge(draft.fromNode, draft.fromSide, targetNodeId);
                this.renderEdges();
                this.selectEdge(edge.id);
                this.commit();
            } else {
                this.renderEdges();
            }
            return;
        }

        if (this.edgeHandleDrag !== null) {
            const drag = this.edgeHandleDrag;
            this.edgeHandleDrag = null;
            this.element.classList.remove('edge-drafting');
            if (this.element.hasPointerCapture(event.pointerId)) {
                this.element.releasePointerCapture(event.pointerId);
            }

            const edge = this.doc.edges.find((e) => e.id === drag.edgeId);
            if (edge !== undefined) {
                const opposite = drag.endpoint === 'from' ? edge.toNode : edge.fromNode;
                const targetNodeId = this.resolveTargetNodeId(event.clientX, event.clientY, opposite);
                if (targetNodeId !== null) {
                    this.rerouteEdge(drag.edgeId, drag.endpoint, targetNodeId);
                    this.commit();
                }
            }
            this.renderEdges();
            return;
        }

        if (this.dragState !== null) {
            const wasMoved = this.dragState.moved;
            this.dragState = null;
            if (this.element.hasPointerCapture(event.pointerId)) {
                this.element.releasePointerCapture(event.pointerId);
            }
            if (wasMoved) this.commit();
            return;
        }

        if (this.panning) {
            this.panning = false;
            this.element.classList.remove('panning');
            if (this.element.hasPointerCapture(event.pointerId)) {
                this.element.releasePointerCapture(event.pointerId);
            }
        }
    };

    private onDoubleClick = (event: MouseEvent): void => {
        if (!this.editable) return;

        const target = event.target as HTMLElement | SVGElement;

        // Dbl-click on an edge → inline label editor at the midpoint.
        if (target instanceof SVGElement) {
            const edgeGroup = target.closest('.canvas-edge-group') as SVGGElement | null;
            if (edgeGroup !== null) {
                const edgeId = edgeGroup.dataset.edgeId;
                if (edgeId !== undefined) {
                    this.startEdgeLabelEdit(edgeId);
                    return;
                }
            }
        }

        const targetEl = target instanceof HTMLElement ? target : null;

        // Dbl-click on a file card = open the note (existing behavior).
        const fileCard = targetEl?.closest('.canvas-card-file') as HTMLElement | null ?? null;
        if (fileCard !== null) {
            const id = fileCard.dataset.nodeId;
            if (id !== undefined) {
                const node = this.nodeById(id);
                if (node !== undefined && node.type === 'file') {
                    this.opts.onOpenNote(node.file);
                }
            }
            return;
        }

        // Dbl-click on a text card = inline edit.
        const textCard = targetEl?.closest('.canvas-card-text') as HTMLElement | null ?? null;
        if (textCard !== null) {
            const id = textCard.dataset.nodeId;
            if (id === undefined) return;
            const body = textCard.querySelector<HTMLElement>('[data-role="text-body"]');
            if (body !== null) this.startTextEdit(id, body);
            return;
        }

        // Dbl-click on a group = edit label.
        const groupEl = targetEl?.closest('.canvas-group') as HTMLElement | null ?? null;
        if (groupEl !== null) {
            const id = groupEl.dataset.nodeId;
            if (id !== undefined) this.startGroupLabelEdit(id);
            return;
        }

        // Dbl-click on empty stage = create a text card at the cursor.
        const {x, y} = this.toWorld(event.clientX, event.clientY);
        const newId = this.addTextCard(x, y);
        const card = this.cardEls.get(newId);
        const body = card?.querySelector<HTMLElement>('[data-role="text-body"]');
        if (body !== null && body !== undefined) {
            this.startTextEdit(newId, body);
        }
    };

    /**
     * Inline label editor for a group node. Positions a small text input
     * at the group's top-left in world space so it lines up with the
     * existing `.canvas-group-label` chrome. Enter/blur commit; Escape
     * cancels; empty string clears the label.
     */
    private startGroupLabelEdit(groupId: string): void {
        const idx = this.doc.nodes.findIndex((n) => n.id === groupId);
        if (idx === -1) return;
        const current = this.doc.nodes[idx];
        if (current === undefined || current.type !== 'group') return;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'canvas-group-label-edit';
        input.value = current.label ?? '';
        input.placeholder = 'group label';
        input.style.left = `${current.x + 8}px`;
        input.style.top = `${current.y - 22}px`;

        this.stage.appendChild(input);
        input.focus();
        input.select();

        let committed = false;
        const commit = (): void => {
            if (committed) return;
            committed = true;
            const next = input.value.trim();
            input.remove();

            const idx2 = this.doc.nodes.findIndex((n) => n.id === groupId);
            if (idx2 === -1) return;
            const now = this.doc.nodes[idx2];
            if (now === undefined || now.type !== 'group') return;

            const previous = now.label ?? '';
            if (previous === next) return;

            const patched = {...now};
            if (next.length === 0) {
                delete patched.label;
            } else {
                patched.label = next;
            }
            const nextNodes = this.doc.nodes.slice();
            nextNodes[idx2] = patched;
            this.doc = {nodes: nextNodes, edges: this.doc.edges};
            this.renderGroups();
            this.commit();
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                commit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                committed = true;
                input.remove();
            }
        });
    }

    /**
     * Inline label editor for an edge. Positions a small text input at the
     * midpoint of the current edge geometry (in stage/world space, so it
     * scales with zoom). Enter or blur commits; Escape cancels. An empty
     * final value clears the label attribute rather than storing "".
     */
    private startEdgeLabelEdit(edgeId: string): void {
        const edge = this.doc.edges.find((e) => e.id === edgeId);
        if (edge === undefined) return;

        const from = this.nodeById(edge.fromNode);
        const to = this.nodeById(edge.toNode);
        if (from === undefined || to === undefined) return;
        if (from.type === 'group' || to.type === 'group') return;

        const a = anchorFor(from, edge.fromSide, to);
        const b = anchorFor(to, edge.toSide, from);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'canvas-edge-label-edit';
        input.value = edge.label ?? '';
        input.placeholder = 'label';
        input.style.left = `${midX}px`;
        input.style.top = `${midY - 12}px`;

        this.stage.appendChild(input);
        input.focus();
        input.select();

        let committed = false;
        const commit = (): void => {
            if (committed) return;
            committed = true;
            const next = input.value.trim();
            input.remove();

            const idx = this.doc.edges.findIndex((e) => e.id === edgeId);
            if (idx === -1) return;
            const current = this.doc.edges[idx];
            if (current === undefined) return;

            const previous = current.label ?? '';
            if (previous === next) return;

            const patched = {...current};
            if (next.length === 0) {
                delete patched.label;
            } else {
                patched.label = next;
            }
            const nextEdges = this.doc.edges.slice();
            nextEdges[idx] = patched;
            this.doc = {nodes: this.doc.nodes, edges: nextEdges};
            this.renderEdges();
            this.commit();
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                commit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                committed = true;
                input.remove();
            }
        });
    }
}