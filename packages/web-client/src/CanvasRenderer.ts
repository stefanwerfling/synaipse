import type {CanvasDocument, CanvasEdge, CanvasNode, CanvasSide, CanvasTextNode} from '@synaipse/core';
import {el} from './Dom.js';
import {renderBottomBar} from './CanvasBottomBar.js';
import {CanvasCamera} from './CanvasCamera.js';
import {renderCards, renderGroups, textBodyOf} from './CanvasCards.js';
import {edgeMidpoint, renderEdges} from './CanvasEdges.js';
import {openLabelEdit, openTextCardEditor} from './CanvasEditors.js';
import {
    computeBounds,
    DEFAULT_TEXT_CARD_H,
    DEFAULT_TEXT_CARD_W,
    genId,
    MIN_CARD_H,
    MIN_CARD_W,
    nodesInsideGroup,
    nodesOverlapping,
    snap,
    withCardText,
    withEdgeArrow,
    withEdgeColor,
    withEdgeLabel,
    withGroupLabel,
    withNodesColor,
    withoutEdge,
    withoutNodes,
    withRerouted,
    type ArrowStyle
} from './CanvasGeometry.js';
import {CanvasHistory} from './CanvasHistory.js';
import {defineMessages} from './I18n.js';

const t = defineMessages('canvasRenderer', {
    groupLabel: 'group label',
    edgeLabel: 'label'
});

// Kept here for existing importers; the implementation lives in CanvasGeometry.
export {nodesInsideGroup} from './CanvasGeometry.js';

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

interface DragState {
    id: string;
    mode: 'move' | 'resize';
    origX: number;
    origY: number;
    origW: number;
    origH: number;
    startClientX: number;
    startClientY: number;
    moved: boolean;
    /**
     * Other nodes moving in lockstep — the rest of a multi-selection and,
     * for a group, everything inside it. Empty for single-drag and for
     * resize (multi-resize is out of scope).
     */
    partners: Array<{id: string; origX: number; origY: number}>;
}

/**
 * "User is drawing a new edge from a source anchor." Nothing reaches the
 * doc until the pointer is released over another card.
 */
interface EdgeDraftState {
    fromNode: string;
    fromSide: CanvasSide;
    x: number;
    y: number;
}

/** "User is dragging one endpoint of the selected edge" — same release semantics, but rewrites the endpoint. */
interface EdgeHandleDragState {
    edgeId: string;
    endpoint: 'from' | 'to';
    x: number;
    y: number;
}

/**
 * Rubber band on empty stage. `group` (Shift) creates a group node from
 * the rect, `multi-select` (Ctrl/Cmd) selects every node it touches —
 * added to the selection with Ctrl/Cmd+Shift. The rect element lives in
 * the stage so it inherits pan/zoom.
 */
interface BandSelectState {
    mode: 'group' | 'multi-select';
    startX: number;
    startY: number;
    x: number;
    y: number;
    additive: boolean;
}

/** Bands smaller than these are accidental clicks, not selections or groups. */
const MIN_MULTI_BAND = 4;
const MIN_GROUP_SIZE = 40;

/**
 * Interactive canvas view (plan P7 / D2 split): owns the document, the
 * selection and the pointer/keyboard interaction. Rendering lives in
 * CanvasCards / CanvasEdges / CanvasBottomBar, pan/zoom in CanvasCamera,
 * undo/redo in CanvasHistory, pure geometry and document operations in
 * CanvasGeometry.
 */
export class CanvasRenderer {
    public readonly element: HTMLElement;
    private stage!: HTMLElement;
    private edgesSvg!: SVGSVGElement;
    private cardsHost!: HTMLElement;
    private groupsHost!: HTMLElement;
    private bottomBar!: HTMLElement;
    private readonly camera = new CanvasCamera();
    private readonly history: CanvasHistory;

    private doc: CanvasDocument;
    private cardEls = new Map<string, HTMLElement>();
    private groupEls = new Map<string, HTMLElement>();
    /**
     * Multi-node selection; single-select is size===1. Edges and nodes are
     * mutually exclusive selection targets (one delete focus, and the
     * bottom bar shows different controls per kind).
     */
    private selectedIds = new Set<string>();
    private selectedEdgeId: string | null = null;
    private editingId: string | null = null;
    /** Force-commits the open modal editor; destroy() uses it so a tab switch never leaves the portalled modal behind. */
    private editingTeardown: (() => void) | null = null;
    private dragState: DragState | null = null;
    private edgeDraft: EdgeDraftState | null = null;
    private edgeHandleDrag: EdgeHandleDragState | null = null;
    private bandSelect: BandSelectState | null = null;
    private bandRectEl: HTMLElement | null = null;

    public constructor(doc: CanvasDocument, private readonly opts: CanvasRendererOptions) {
        this.doc = doc;
        this.history = new CanvasHistory(doc);
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
        // Tear down the modal editor first so the portalled card and
        // backdrop (under document.body) don't outlive the panel.
        this.stopEditing();
        document.removeEventListener('keydown', this.onKeyDown);
    }

    /** Force-close the modal editor, committing pending text. Called by the panel on tab switch. */
    public stopEditing(): void {
        this.editingTeardown?.();
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

        this.bottomBar = el('div', {class: 'canvas-bottom-bar', attrs: {hidden: 'hidden'}});

        this.element.appendChild(this.stage);
        this.element.appendChild(this.bottomBar);

        this.element.addEventListener('wheel', this.onWheel, {passive: false});
        this.element.addEventListener('pointerdown', this.onPointerDown);
        this.element.addEventListener('pointermove', this.onPointerMove);
        this.element.addEventListener('pointerup', this.onPointerUp);
        this.element.addEventListener('pointercancel', this.onPointerUp);
        this.element.addEventListener('dblclick', this.onDoubleClick);
        document.addEventListener('keydown', this.onKeyDown);

        this.renderAll();
    }

    // ─── Rendering ───

    private renderAll(): void {
        this.renderGroups();
        this.cardEls = renderCards(this.cardsHost, this.doc, {
            selected: this.selectedIds,
            editable: this.editable,
            onOpenLink: this.opts.onOpenLink
        });
        this.renderEdges();
    }

    private renderGroups(): void {
        this.groupEls = renderGroups(this.groupsHost, this.doc, this.selectedIds);
    }

    private renderEdges(): void {
        renderEdges(this.edgesSvg, this.doc, {
            selectedEdgeId: this.selectedEdgeId,
            editable: this.editable,
            handleDrag: this.edgeHandleDrag,
            draft: this.edgeDraft
        });
    }

    private refreshBottomBar(): void {
        renderBottomBar(this.bottomBar, this.doc, {edgeId: this.selectedEdgeId, nodeIds: [...this.selectedIds]}, {
            setNodesColor: (ids, preset) => this.apply(withNodesColor(this.doc, ids, preset), 'all'),
            setEdgeColor: (id, preset) => this.apply(withEdgeColor(this.doc, id, preset), 'edges'),
            setEdgeArrow: (id, style: ArrowStyle) => this.apply(withEdgeArrow(this.doc, id, style), 'edges'),
            removeNodes: (ids) => this.removeNodes(ids),
            removeEdge: (id) => this.removeEdge(id),
            editText: (id) => {
                const body = textBodyOf(this.cardEls.get(id));
                if (body !== null) this.startTextEdit(id, body);
            },
            openNote: (fileId) => this.opts.onOpenNote(fileId)
        });
    }

    private fitView(): void {
        this.camera.fit(computeBounds(this.doc.nodes), this.element.clientWidth || 1200, this.element.clientHeight || 800);
        this.applyTransform();
    }

    private applyTransform(): void {
        this.stage.style.transform = this.camera.transform();
    }

    // ─── Selection ───

    /** Single-node selection (or none for null), replacing any prior multi-selection. */
    private selectNode(id: string | null): void {
        this.clearEdgeSelectionOnly();
        for (const prev of this.selectedIds) {
            if (prev === id) continue;
            this.nodeElement(prev)?.classList.remove('selected');
        }
        this.selectedIds.clear();
        if (id !== null) {
            this.selectedIds.add(id);
            this.nodeElement(id)?.classList.add('selected');
        }
        this.refreshBottomBar();
    }

    /** Shift-click: add or remove one node. */
    private toggleNodeSelection(id: string): void {
        this.clearEdgeSelectionOnly();
        if (this.selectedIds.has(id)) {
            this.selectedIds.delete(id);
            this.nodeElement(id)?.classList.remove('selected');
        } else {
            this.selectedIds.add(id);
            this.nodeElement(id)?.classList.add('selected');
        }
        this.refreshBottomBar();
    }

    /** Rubber-band result: replace the selection, or add to it. */
    private setMultiSelection(ids: string[], additive: boolean): void {
        this.clearEdgeSelectionOnly();
        if (!additive) {
            for (const prev of this.selectedIds) {
                this.nodeElement(prev)?.classList.remove('selected');
            }
            this.selectedIds.clear();
        }
        for (const id of ids) {
            if (this.selectedIds.has(id)) continue;
            this.selectedIds.add(id);
            this.nodeElement(id)?.classList.add('selected');
        }
        this.refreshBottomBar();
    }

    private clearEdgeSelectionOnly(): void {
        if (this.selectedEdgeId === null) return;
        this.selectedEdgeId = null;
        this.renderEdges();
    }

    private selectEdge(id: string | null): void {
        if (this.selectedIds.size > 0) {
            for (const prev of this.selectedIds) {
                this.nodeElement(prev)?.classList.remove('selected');
            }
            this.selectedIds.clear();
        }
        if (this.selectedEdgeId === id) return;
        this.selectedEdgeId = id;
        this.renderEdges();
        this.refreshBottomBar();
    }

    /** DOM lookup covering both cards and groups. */
    private nodeElement(id: string): HTMLElement | undefined {
        return this.cardEls.get(id) ?? this.groupEls.get(id);
    }

    private nodeById(id: string): CanvasNode | undefined {
        return this.doc.nodes.find((n) => n.id === id);
    }

    // ─── Mutations + history ───

    /** Persist the current doc and record the previous one for undo. */
    private commit(): void {
        this.history.record(this.doc);
        this.opts.onChange?.(this.doc);
    }

    /** Swap in a new document, redraw what it touched, refresh the bar and commit. */
    private apply(next: CanvasDocument, redraw: 'all' | 'edges'): void {
        this.doc = next;
        if (redraw === 'all') this.renderAll();
        else this.renderEdges();
        this.refreshBottomBar();
        this.commit();
    }

    public undo(): void {
        const prev = this.history.undo();
        if (prev !== undefined) this.restore(prev);
    }

    public redo(): void {
        const next = this.history.redo();
        if (next !== undefined) this.restore(next);
    }

    /**
     * Show and persist a history snapshot without recording it as a new
     * action. Selection doesn't survive — an old id may point at a node
     * that no longer exists in the restored doc.
     */
    private restore(doc: CanvasDocument): void {
        this.doc = doc;
        this.selectedIds.clear();
        this.selectedEdgeId = null;
        this.renderAll();
        this.refreshBottomBar();
        this.opts.onChange?.(this.doc);
    }

    private removeNodes(ids: string[]): void {
        if (ids.length === 0) return;
        for (const id of ids) this.selectedIds.delete(id);
        this.apply(withoutNodes(this.doc, ids), 'all');
    }

    private removeEdge(id: string): void {
        this.doc = withoutEdge(this.doc, id);
        if (this.selectedEdgeId === id) this.selectedEdgeId = null;
        this.renderEdges();
        this.commit();
    }

    private addEdge(fromNode: string, fromSide: CanvasSide, toNode: string): CanvasEdge {
        const edge: CanvasEdge = {id: genId(), fromNode, toNode, fromSide, toEnd: 'arrow'};
        this.doc = {nodes: this.doc.nodes, edges: [...this.doc.edges, edge]};
        return edge;
    }

    private addGroup(x: number, y: number, width: number, height: number): void {
        const node = {id: genId(), type: 'group' as const, x, y, width, height, label: ''};
        this.doc = {nodes: [...this.doc.nodes, node], edges: this.doc.edges};
        this.renderAll();
        this.commit();
    }

    public addTextCard(worldX: number, worldY: number, text = ''): string {
        const id = genId();
        const node: CanvasTextNode = {
            id,
            type: 'text',
            x: snap(worldX - DEFAULT_TEXT_CARD_W / 2),
            y: snap(worldY - DEFAULT_TEXT_CARD_H / 2),
            width: DEFAULT_TEXT_CARD_W,
            height: DEFAULT_TEXT_CARD_H,
            text
        };
        this.doc = {nodes: [...this.doc.nodes, node], edges: this.doc.edges};
        this.renderAll();
        this.selectNode(id);
        this.commit();
        return id;
    }

    // ─── Geometry helpers bound to the viewport ───

    /** Page coordinates → stage/world coordinates. */
    private toWorld(clientX: number, clientY: number): {x: number; y: number} {
        const rect = this.element.getBoundingClientRect();
        return this.camera.toWorld(clientX - rect.left, clientY - rect.top);
    }

    /**
     * The card under the pointer, unless it is `skipNodeId` (rejects
     * self-loops for edge create and reroute). Groups never count —
     * edges only connect real cards.
     */
    private resolveTargetNodeId(clientX: number, clientY: number, skipNodeId: string): string | null {
        const hit = document.elementFromPoint(clientX, clientY);
        if (hit === null) return null;
        const cardEl = (hit as HTMLElement).closest('.canvas-card') as HTMLElement | null;
        if (cardEl === null) return null;
        const id = cardEl.dataset.nodeId;
        if (id === undefined || id === skipNodeId) return null;
        const node = this.nodeById(id);
        if (node === undefined || node.type === 'group') return null;
        return id;
    }

    private updateBandRect(): void {
        if (this.bandSelect === null || this.bandRectEl === null) return;
        const {startX, startY, x, y} = this.bandSelect;
        this.bandRectEl.style.left = `${Math.min(startX, x)}px`;
        this.bandRectEl.style.top = `${Math.min(startY, y)}px`;
        this.bandRectEl.style.width = `${Math.abs(x - startX)}px`;
        this.bandRectEl.style.height = `${Math.abs(y - startY)}px`;
    }

    private releasePointer(event: PointerEvent): void {
        if (this.element.hasPointerCapture(event.pointerId)) {
            this.element.releasePointerCapture(event.pointerId);
        }
    }

    // ─── Editing ───

    private startTextEdit(id: string, body: HTMLElement): void {
        if (this.editingId === id) return;
        this.editingId = id;

        const node = this.nodeById(id);
        if (node === undefined || node.type !== 'text') return;

        this.editingTeardown = openTextCardEditor(this.cardEls.get(id), body, node.text, (nextText) => {
            this.editingId = null;
            this.editingTeardown = null;
            const current = this.nodeById(id);
            if (current === undefined || current.type !== 'text' || current.text === nextText) return;
            this.doc = withCardText(this.doc, id, nextText);
            this.commit();
        });
    }

    /** Label input at the group's top-left, lined up with `.canvas-group-label`. */
    private startGroupLabelEdit(groupId: string): void {
        const group = this.nodeById(groupId);
        if (group === undefined || group.type !== 'group') return;

        openLabelEdit(this.stage, {
            className: 'canvas-group-label-edit',
            value: group.label ?? '',
            placeholder: t('groupLabel'),
            left: group.x + 8,
            top: group.y - 22,
            onCommit: (next) => {
                const now = this.nodeById(groupId);
                if (now === undefined || now.type !== 'group' || (now.label ?? '') === next) return;
                this.doc = withGroupLabel(this.doc, groupId, next);
                this.renderGroups();
                this.commit();
            }
        });
    }

    /** Label input at the edge's midpoint. */
    private startEdgeLabelEdit(edgeId: string): void {
        const edge = this.doc.edges.find((e) => e.id === edgeId);
        const mid = edgeMidpoint(this.doc, edgeId);
        if (edge === undefined || mid === null) return;

        openLabelEdit(this.stage, {
            className: 'canvas-edge-label-edit',
            value: edge.label ?? '',
            placeholder: t('edgeLabel'),
            left: mid.x,
            top: mid.y - 12,
            onCommit: (next) => {
                const now = this.doc.edges.find((e) => e.id === edgeId);
                if (now === undefined || (now.label ?? '') === next) return;
                this.doc = withEdgeLabel(this.doc, edgeId, next);
                this.renderEdges();
                this.commit();
            }
        });
    }

    // ─── Keyboard ───

    private onKeyDown = (event: KeyboardEvent): void => {
        if (!this.editable) return;
        if (!this.element.isConnected) return;
        if (this.editingId !== null) return; // typing in the editor

        // Don't catch shortcuts while the user types in an unrelated
        // input elsewhere on the page (chat box, settings, …).
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
        if (active instanceof HTMLElement && active.isContentEditable) return;

        // Cmd/Ctrl-Z = undo; Cmd/Ctrl-Shift-Z or Cmd/Ctrl-Y = redo.
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
            const k = event.key.toLowerCase();
            if (k === 'z' && !event.shiftKey) {
                event.preventDefault();
                this.undo();
                return;
            }
            if ((k === 'z' && event.shiftKey) || k === 'y') {
                event.preventDefault();
                this.redo();
                return;
            }
        }

        if (event.key !== 'Delete' && event.key !== 'Backspace') return;

        if (this.selectedEdgeId !== null) {
            event.preventDefault();
            this.removeEdge(this.selectedEdgeId);
            return;
        }
        if (this.selectedIds.size > 0) {
            event.preventDefault();
            this.removeNodes([...this.selectedIds]);
        }
    };

    // ─── Pointer ───

    private onWheel = (event: WheelEvent): void => {
        event.preventDefault();
        const rect = this.element.getBoundingClientRect();
        this.camera.zoomAt(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0);
        this.applyTransform();
    };

    /** Start a move/resize drag on `node` with the given partners. */
    private beginDrag(event: PointerEvent, node: CanvasNode, mode: DragState['mode'], partners: DragState['partners']): void {
        this.dragState = {
            id: node.id,
            mode,
            origX: node.x,
            origY: node.y,
            origW: node.width,
            origH: node.height,
            startClientX: event.clientX,
            startClientY: event.clientY,
            moved: false,
            partners
        };
        // Alongside `user-select: none` on the card: suppress the native
        // text selection that would otherwise start under the pointer and
        // eventually cancel the drag.
        event.preventDefault();
        this.element.setPointerCapture(event.pointerId);
    }

    /** Current positions of the other selected nodes, for a lockstep move. */
    private selectionPartners(exceptId: string): DragState['partners'] {
        const partners: DragState['partners'] = [];
        if (this.selectedIds.size <= 1) return partners;
        for (const otherId of this.selectedIds) {
            if (otherId === exceptId) continue;
            const other = this.nodeById(otherId);
            if (other !== undefined) partners.push({id: otherId, origX: other.x, origY: other.y});
        }
        return partners;
    }

    /**
     * Shift toggles the node in the selection (no drag, returns false);
     * otherwise a click on an unselected node selects only it, and a
     * click on a selected node keeps the selection so the drag moves all.
     */
    private pickForDrag(event: PointerEvent, id: string): boolean {
        if (event.shiftKey) {
            this.toggleNodeSelection(id);
            event.preventDefault();
            return false;
        }
        if (!this.selectedIds.has(id)) this.selectNode(id);
        return true;
    }

    private onPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0) return;

        const target = event.target as HTMLElement | SVGElement;

        // Inputs and links inside cards handle their own clicks.
        if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'A') return;

        // Bottom-bar clicks belong to its actions — the empty-background
        // branch below would otherwise clear the selection and detach the
        // button before its click handler runs.
        if (target instanceof HTMLElement && target.closest('.canvas-bottom-bar') !== null) return;

        // Edge-first: an anchor dot beats the card behind it, an edge
        // handle beats the edge behind it, an edge beats empty background.
        if (this.editable && target instanceof HTMLElement && target.dataset.role === 'anchor') {
            const fromNode = (target.closest('.canvas-card') as HTMLElement | null)?.dataset.nodeId;
            const side = target.dataset.side as CanvasSide | undefined;
            if (fromNode !== undefined && side !== undefined) {
                this.edgeDraft = {fromNode, fromSide: side, ...this.toWorld(event.clientX, event.clientY)};
                this.element.classList.add('edge-drafting');
                this.element.setPointerCapture(event.pointerId);
                this.renderEdges();
                return;
            }
        }

        if (this.editable && target instanceof SVGElement && target.classList.contains('canvas-edge-handle')) {
            const edgeId = target.dataset.edgeId;
            const endpoint = target.dataset.endpoint;
            if (edgeId !== undefined && (endpoint === 'from' || endpoint === 'to')) {
                this.edgeHandleDrag = {edgeId, endpoint, ...this.toWorld(event.clientX, event.clientY)};
                this.element.classList.add('edge-drafting');
                this.element.setPointerCapture(event.pointerId);
                this.renderEdges();
                return;
            }
        }

        if (target instanceof SVGElement) {
            const edgeId = (target.closest('.canvas-edge-group') as SVGGElement | null)?.dataset.edgeId;
            if (edgeId !== undefined) {
                this.selectEdge(edgeId);
                return;
            }
        }

        const targetEl = target instanceof HTMLElement ? target : null;

        const cardEl = targetEl?.closest('.canvas-card') as HTMLElement | null ?? null;
        if (cardEl !== null && this.editable) {
            const id = cardEl.dataset.nodeId;
            const node = id === undefined ? undefined : this.nodeById(id);
            if (id === undefined || node === undefined) return;
            if (!this.pickForDrag(event, id)) return;

            // Never drag while the text editor is open on this card.
            if (this.editingId === id) return;

            // Resize is single-card only.
            const isResize = targetEl?.dataset.role === 'resize';
            this.beginDrag(event, node, isResize ? 'resize' : 'move', isResize ? [] : this.selectionPartners(id));
            return;
        }

        // Group frame: a container move that carries every node
        // geometrically inside it (children + nested groups), merged with
        // the rest of a multi-selection.
        const groupEl = targetEl?.closest('.canvas-group') as HTMLElement | null ?? null;
        if (groupEl !== null && this.editable) {
            const id = groupEl.dataset.nodeId;
            const node = id === undefined ? undefined : this.nodeById(id);
            if (id === undefined || node === undefined || node.type !== 'group') return;
            if (!this.pickForDrag(event, id)) return;

            const partners = new Map(this.selectionPartners(id).map((p) => [p.id, p]));
            for (const contained of nodesInsideGroup(node, this.doc.nodes)) {
                if (!partners.has(contained.id)) {
                    partners.set(contained.id, {id: contained.id, origX: contained.x, origY: contained.y});
                }
            }
            this.beginDrag(event, node, 'move', [...partners.values()]);
            return;
        }

        // Empty background: Shift-drag → group band, Ctrl/Cmd-drag →
        // multi-select band, no modifier → pan. A plain click clears the
        // selection first.
        if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
            this.selectNode(null);
            this.selectEdge(null);
        }

        if (this.editable && (event.shiftKey || event.ctrlKey || event.metaKey)) {
            const isMulti = event.ctrlKey || event.metaKey;
            const {x, y} = this.toWorld(event.clientX, event.clientY);
            this.bandSelect = {
                mode: isMulti ? 'multi-select' : 'group',
                startX: x,
                startY: y,
                x,
                y,
                additive: isMulti && event.shiftKey
            };
            this.bandRectEl = el('div', {class: isMulti ? 'canvas-band-rect canvas-band-rect-multi' : 'canvas-band-rect'});
            this.stage.appendChild(this.bandRectEl);
            this.updateBandRect();
            this.element.setPointerCapture(event.pointerId);
            return;
        }

        this.camera.startPan(event.clientX, event.clientY);
        this.element.classList.add('panning');
        this.element.setPointerCapture(event.pointerId);
    };

    private onPointerMove = (event: PointerEvent): void => {
        const live = this.bandSelect ?? this.edgeDraft ?? this.edgeHandleDrag;
        if (live !== null) {
            const {x, y} = this.toWorld(event.clientX, event.clientY);
            live.x = x;
            live.y = y;
            if (live === this.bandSelect) this.updateBandRect();
            else this.renderEdges();
            return;
        }

        if (this.dragState !== null) {
            this.dragTo(this.dragState, event);
            return;
        }

        if (this.camera.panning) {
            this.camera.panTo(event.clientX, event.clientY);
            this.applyTransform();
        }
    };

    /**
     * Live move/resize. Nodes are mutated in place (committed on pointer
     * up); Alt held → pixel-precise, otherwise snapped to the grid — read
     * on every move so it can be toggled mid-drag.
     */
    private dragTo(drag: DragState, event: PointerEvent): void {
        const dx = (event.clientX - drag.startClientX) / this.camera.scale;
        const dy = (event.clientY - drag.startClientY) / this.camera.scale;
        if (!drag.moved && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) drag.moved = true;

        const node = this.nodeById(drag.id);
        // Cards and group frames live in different maps — nodeElement covers both.
        const primaryEl = this.nodeElement(drag.id);
        if (node === undefined || primaryEl === undefined) return;

        const align = (v: number): number => event.altKey ? Math.round(v) : snap(v);

        if (drag.mode === 'move') {
            node.x = align(drag.origX + dx);
            node.y = align(drag.origY + dy);
            primaryEl.style.left = `${node.x}px`;
            primaryEl.style.top = `${node.y}px`;

            // Same delta for every partner; each snaps on its own grid slot
            // so an already-aligned group stays aligned.
            for (const partner of drag.partners) {
                const other = this.nodeById(partner.id);
                if (other === undefined) continue;
                other.x = align(partner.origX + dx);
                other.y = align(partner.origY + dy);
                const partnerEl = this.nodeElement(partner.id);
                if (partnerEl !== undefined) {
                    partnerEl.style.left = `${other.x}px`;
                    partnerEl.style.top = `${other.y}px`;
                }
            }
        } else {
            node.width = Math.max(MIN_CARD_W, align(drag.origW + dx));
            node.height = Math.max(MIN_CARD_H, align(drag.origH + dy));
            primaryEl.style.width = `${node.width}px`;
            primaryEl.style.height = `${node.height}px`;
        }

        this.renderEdges();
    }

    private onPointerUp = (event: PointerEvent): void => {
        if (this.bandSelect !== null) {
            const band = this.bandSelect;
            this.bandSelect = null;
            this.bandRectEl?.remove();
            this.bandRectEl = null;
            this.releasePointer(event);
            this.finishBand(band);
            return;
        }

        if (this.edgeDraft !== null) {
            const draft = this.edgeDraft;
            this.edgeDraft = null;
            this.element.classList.remove('edge-drafting');
            this.releasePointer(event);

            const targetNodeId = this.resolveTargetNodeId(event.clientX, event.clientY, draft.fromNode);
            if (targetNodeId === null) {
                this.renderEdges();
                return;
            }
            const edge = this.addEdge(draft.fromNode, draft.fromSide, targetNodeId);
            this.renderEdges();
            this.selectEdge(edge.id);
            this.commit();
            return;
        }

        if (this.edgeHandleDrag !== null) {
            const drag = this.edgeHandleDrag;
            this.edgeHandleDrag = null;
            this.element.classList.remove('edge-drafting');
            this.releasePointer(event);

            const edge = this.doc.edges.find((e) => e.id === drag.edgeId);
            if (edge !== undefined) {
                const opposite = drag.endpoint === 'from' ? edge.toNode : edge.fromNode;
                const targetNodeId = this.resolveTargetNodeId(event.clientX, event.clientY, opposite);
                if (targetNodeId !== null) {
                    this.doc = withRerouted(this.doc, drag.edgeId, drag.endpoint, targetNodeId);
                    this.commit();
                }
            }
            this.renderEdges();
            return;
        }

        if (this.dragState !== null) {
            const wasMoved = this.dragState.moved;
            this.dragState = null;
            this.releasePointer(event);
            if (wasMoved) this.commit();
            return;
        }

        if (this.camera.panning) {
            this.camera.endPan();
            this.element.classList.remove('panning');
            this.releasePointer(event);
        }
    };

    private finishBand(band: BandSelectState): void {
        const minX = Math.min(band.startX, band.x);
        const minY = Math.min(band.startY, band.y);
        const maxX = Math.max(band.startX, band.x);
        const maxY = Math.max(band.startY, band.y);
        const width = maxX - minX;
        const height = maxY - minY;

        if (band.mode === 'multi-select') {
            // Overlap, not full containment: a partial sweep captures the
            // nodes the user visibly touched.
            if (width >= MIN_MULTI_BAND || height >= MIN_MULTI_BAND) {
                this.setMultiSelection(nodesOverlapping(this.doc.nodes, minX, minY, maxX, maxY), band.additive);
            }
            return;
        }

        // Group bounds snap to the grid so a group of snapped cards has
        // coherent geometry (no Alt bypass — bands are low-precision anyway).
        if (width >= MIN_GROUP_SIZE && height >= MIN_GROUP_SIZE) {
            this.addGroup(snap(minX), snap(minY), snap(width), snap(height));
        }
    }

    private onDoubleClick = (event: MouseEvent): void => {
        if (!this.editable) return;

        // pointerdown on a card or group captures the pointer on the
        // viewport, so the browser retargets the following dblclick to the
        // viewport itself. Hit-test the position instead of trusting
        // event.target, or every card/group double-click would land on
        // "empty stage" and spawn a new card.
        const hit = document.elementFromPoint(event.clientX, event.clientY);
        const target = (hit !== null && this.element.contains(hit) ? hit : event.target) as HTMLElement | SVGElement;

        // Edge → inline label editor at the midpoint.
        if (target instanceof SVGElement) {
            const edgeId = (target.closest('.canvas-edge-group') as SVGGElement | null)?.dataset.edgeId;
            if (edgeId !== undefined) {
                this.startEdgeLabelEdit(edgeId);
                return;
            }
        }

        const targetEl = target instanceof HTMLElement ? target : null;

        // File card → open the note.
        const fileCard = targetEl?.closest('.canvas-card-file') as HTMLElement | null ?? null;
        if (fileCard !== null) {
            const id = fileCard.dataset.nodeId;
            const node = id === undefined ? undefined : this.nodeById(id);
            if (node !== undefined && node.type === 'file') this.opts.onOpenNote(node.file);
            return;
        }

        // Text card → edit.
        const textCard = targetEl?.closest('.canvas-card-text') as HTMLElement | null ?? null;
        if (textCard !== null) {
            const id = textCard.dataset.nodeId;
            const body = textBodyOf(textCard);
            if (id !== undefined && body !== null) this.startTextEdit(id, body);
            return;
        }

        // Group → edit its label.
        const groupEl = targetEl?.closest('.canvas-group') as HTMLElement | null ?? null;
        if (groupEl !== null) {
            const id = groupEl.dataset.nodeId;
            if (id !== undefined) this.startGroupLabelEdit(id);
            return;
        }

        // Empty stage → new text card at the cursor, straight into the editor.
        const {x, y} = this.toWorld(event.clientX, event.clientY);
        const newId = this.addTextCard(x, y);
        const body = textBodyOf(this.cardEls.get(newId));
        if (body !== null) this.startTextEdit(newId, body);
    };
}
