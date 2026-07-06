import type {CanvasDocument, CanvasNode, CanvasSide, CanvasTextNode} from '@synaipse/core';
import {api} from './Api.js';
import {clear, el} from './Dom.js';
import {renderMarkdownInto} from './MarkdownPreview.js';

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
    private editingId: string | null = null;
    private dragState: DragState | null = null;

    private onKeyDown = (event: KeyboardEvent): void => {
        if (!this.editable) return;
        if (!this.element.isConnected) return;
        if (this.editingId !== null) return; // typing in textarea
        if (event.key !== 'Delete' && event.key !== 'Backspace') return;
        if (this.selectedId === null) return;

        // Guard against removing while the user was typing in an
        // unrelated input elsewhere on the page.
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;

        event.preventDefault();
        this.removeNode(this.selectedId);
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

            const a = anchorFor(from, edge.fromSide, to);
            const b = anchorFor(to, edge.toSide, from);
            const color = resolveColor(edge.color, 'var(--accent)');

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', String(a.x));
            line.setAttribute('y1', String(a.y));
            line.setAttribute('x2', String(b.x));
            line.setAttribute('y2', String(b.y));
            line.setAttribute('stroke', color);
            line.setAttribute('stroke-width', '2');
            line.style.color = color;
            if (edge.toEnd !== 'none') {
                line.setAttribute('marker-end', 'url(#canvas-arrow)');
            }
            this.edgesSvg.appendChild(line);

            if (edge.label !== undefined && edge.label.length > 0) {
                const midX = (a.x + b.x) / 2;
                const midY = (a.y + b.y) / 2;
                const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                text.setAttribute('x', String(midX));
                text.setAttribute('y', String(midY - 6));
                text.setAttribute('text-anchor', 'middle');
                text.setAttribute('fill', color);
                text.setAttribute('font-size', '12');
                text.textContent = edge.label;
                this.edgesSvg.appendChild(text);
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
    }

    // ─── Selection ───

    private select(id: string | null): void {
        if (this.selectedId === id) return;
        if (this.selectedId !== null) {
            this.cardEls.get(this.selectedId)?.classList.remove('selected');
        }
        this.selectedId = id;
        if (id !== null) {
            this.cardEls.get(id)?.classList.add('selected');
        }
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
        this.select(id);
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

        const target = event.target as HTMLElement;

        // Textareas: let the browser handle the click normally.
        if (target.tagName === 'TEXTAREA') return;
        // Links inside cards: let them be clicked normally.
        if (target.tagName === 'A') return;

        const cardEl = target.closest('.canvas-card') as HTMLElement | null;
        const isResizeHandle = target.dataset.role === 'resize';

        if (cardEl !== null && this.editable) {
            const id = cardEl.dataset.nodeId;
            if (id === undefined) return;
            const node = this.nodeById(id);
            if (node === undefined) return;

            this.select(id);

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

        // Empty background — deselect + start panning.
        this.select(null);
        this.panning = true;
        this.panStartX = event.clientX;
        this.panStartY = event.clientY;
        this.panStartTx = this.tx;
        this.panStartTy = this.ty;
        this.element.classList.add('panning');
        this.element.setPointerCapture(event.pointerId);
    };

    private onPointerMove = (event: PointerEvent): void => {
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

        const target = event.target as HTMLElement;

        // Dbl-click on a file card = open the note (existing behavior).
        const fileCard = target.closest('.canvas-card-file') as HTMLElement | null;
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
        const textCard = target.closest('.canvas-card-text') as HTMLElement | null;
        if (textCard !== null) {
            const id = textCard.dataset.nodeId;
            if (id === undefined) return;
            const body = textCard.querySelector<HTMLElement>('[data-role="text-body"]');
            if (body !== null) this.startTextEdit(id, body);
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
}