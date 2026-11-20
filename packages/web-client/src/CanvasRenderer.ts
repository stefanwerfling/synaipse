import type {CanvasDocument, CanvasEdge, CanvasNode, CanvasSide, CanvasTextNode} from '@synaipse/core';
import {RectBoard, RectHistory, type RectBoardChange, type RectEdgeSpec} from 'jsngraph';
import {el} from './Dom.js';
import {renderBottomBar} from './CanvasBottomBar.js';
import {buildCard, buildGroup, textBodyOf} from './CanvasCards.js';
import {openLabelEdit, openTextCardEditor} from './CanvasEditors.js';
import {
    DEFAULT_TEXT_CARD_H,
    DEFAULT_TEXT_CARD_W,
    genId,
    GRID_STEP,
    MIN_CARD_H,
    MIN_CARD_W,
    nodesInsideGroup,
    resolveColor,
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

/** A Shift band smaller than this is an accidental click, not a group. */
const MIN_GROUP_SIZE = 40;

/**
 * Interactive canvas view (plan P7 / D2, P10 / S6). Camera, card drag and
 * resize, side anchors, connector routing and drawing, reroute, rubber
 * bands and hit-testing come from the jsNGraph RectBoard; this class owns
 * the JSON Canvas document, turns the board's `commit` events into
 * document changes, keeps the undo history and runs the editors and the
 * bottom bar. Group frames carry their contents through `dragPartners`.
 */
export class CanvasRenderer {
    public readonly element: HTMLElement;
    private readonly board: RectBoard;
    private readonly bottomBar: HTMLElement;
    private readonly history: RectHistory<CanvasDocument>;

    private doc: CanvasDocument;
    private cardEls = new Map<string, HTMLElement>();
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

    public constructor(doc: CanvasDocument, private readonly opts: CanvasRendererOptions) {
        this.doc = doc;
        this.history = new RectHistory(doc);
        this.element = el('div', {class: 'canvas-viewport', attrs: {tabindex: '0'}});
        this.board = new RectBoard(this.element, {
            editable: this.editable,
            grid: GRID_STEP,
            minItemSize: {w: MIN_CARD_W, h: MIN_CARD_H},
            minScale: 0.15,
            maxScale: 4,
            zoomStep: 1.15,
            padding: 40,
            curve: {factor: 0.4, min: 32, max: 160},
            selectedClass: 'selected',
            edgeLabels: 'pill',
            dragPartners: (id) => this.groupContents(id)
        });
        this.board.stage.classList.add('canvas-stage');
        this.bottomBar = el('div', {class: 'canvas-bottom-bar', attrs: {hidden: 'hidden'}});
        this.element.appendChild(this.bottomBar);

        this.board
            .on('commit', (change) => this.onBoardCommit(change))
            .on('select', (ids) => {
                this.selectedIds = new Set(ids);
                if (ids.length > 0) this.selectedEdgeId = null;
                this.refreshBottomBar();
            })
            .on('edgeSelect', (id) => {
                this.selectedEdgeId = id;
                if (id !== null) this.selectedIds.clear();
                this.refreshBottomBar();
            })
            .on('band', (rect, mods) => {
                // Ctrl/Cmd bands select (the board does that); a Shift band draws a group.
                if (mods.shift && !mods.ctrl && rect.w >= MIN_GROUP_SIZE && rect.h >= MIN_GROUP_SIZE) {
                    this.addGroup(snap(rect.x), snap(rect.y), snap(rect.w), snap(rect.h));
                }
            })
            .on('itemDblClick', (id) => this.onNodeDoubleClick(id))
            .on('edgeDblClick', (id) => this.startEdgeLabelEdit(id))
            .on('backgroundDblClick', (point) => {
                const newId = this.addTextCard(point.x, point.y);
                const body = textBodyOf(this.cardEls.get(newId));
                if (body !== null) this.startTextEdit(newId, body);
            });

        document.addEventListener('keydown', this.onKeyDown);
        this.renderAll();
    }

    private get editable(): boolean {
        return this.opts.editable !== false;
    }

    public mount(): void {
        this.board.fitAll(false);
    }

    public destroy(): void {
        // Tear down the modal editor first so the portalled card and
        // backdrop (under document.body) don't outlive the panel.
        this.stopEditing();
        document.removeEventListener('keydown', this.onKeyDown);
        this.board.destroy();
    }

    /** Force-close the modal editor, committing pending text. Called by the panel on tab switch. */
    public stopEditing(): void {
        this.editingTeardown?.();
    }

    /** Current document — CanvasPanel reads this to persist. */
    public getDoc(): CanvasDocument {
        return this.doc;
    }

    // ─── Rendering ───

    /** Rebuild every frame, card and connector from the document; the board keeps the selection by id. */
    private renderAll(): void {
        this.board.clear();
        this.cardEls = new Map();
        for (const node of this.doc.nodes) {
            const geometry = {w: node.width, h: node.height};
            if (node.type === 'group') {
                this.board.add(buildGroup(node), node.x, node.y, node.id, {...geometry, layer: 'back', resizable: false, connectable: false});
                continue;
            }
            const card = buildCard(node, {editable: this.editable, onOpenLink: this.opts.onOpenLink});
            this.board.add(card, node.x, node.y, node.id, geometry);
            this.cardEls.set(node.id, card);
        }
        this.renderEdges();
        this.board.select(this.selectedIds);
        if (this.selectedEdgeId !== null) this.board.selectEdge(this.selectedEdgeId);
    }

    /** Connectors from the document; edges touching a group are not drawn (Obsidian's rule). */
    private renderEdges(): void {
        const groups = new Set(this.doc.nodes.filter((n) => n.type === 'group').map((n) => n.id));
        const specs: RectEdgeSpec[] = [];
        for (const edge of this.doc.edges) {
            if (groups.has(edge.fromNode) || groups.has(edge.toNode)) continue;
            specs.push({
                id: edge.id,
                from: edge.fromNode,
                to: edge.toNode,
                ...(edge.fromSide !== undefined ? {fromSide: edge.fromSide} : {}),
                ...(edge.toSide !== undefined ? {toSide: edge.toSide} : {}),
                color: resolveColor(edge.color, 'var(--accent)'),
                arrow: edge.toEnd !== 'none',
                fromArrow: edge.fromEnd === 'arrow',
                className: 'canvas-edge-group',
                ...(edge.label !== undefined && edge.label.length > 0 ? {label: edge.label} : {})
            });
        }
        this.board.setEdges(specs);
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

    // ─── Board → document ───

    /** Everything geometrically inside a group moves with it (children and nested groups). */
    private groupContents(id: string): string[] {
        const node = this.nodeById(id);
        return node?.type === 'group' ? nodesInsideGroup(node, this.doc.nodes).map((n) => n.id) : [];
    }

    private onBoardCommit(change: RectBoardChange): void {
        switch (change.type) {
            case 'move':
                for (const moved of change.items) {
                    const node = this.nodeById(moved.id);
                    if (node === undefined) continue;
                    node.x = moved.to.x;
                    node.y = moved.to.y;
                }
                this.commit();
                return;
            case 'resize': {
                const node = this.nodeById(change.id);
                if (node === undefined) return;
                node.width = change.to.w;
                node.height = change.to.h;
                this.commit();
                return;
            }
            case 'connect': {
                const edge = this.addEdge(change.from, change.fromSide, change.to);
                this.renderEdges();
                this.board.selectEdge(edge.id, true);
                this.commit();
                return;
            }
            case 'reroute':
                this.doc = withRerouted(this.doc, change.edgeId, change.endpoint, change.to);
                this.renderEdges();
                this.commit();
                return;
        }
    }

    private onNodeDoubleClick(id: string): void {
        const node = this.nodeById(id);
        if (node === undefined) return;
        if (node.type === 'file') {
            this.opts.onOpenNote(node.file);
        } else if (node.type === 'text') {
            const body = textBodyOf(this.cardEls.get(id));
            if (body !== null) this.startTextEdit(id, body);
        } else if (node.type === 'group') {
            this.startGroupLabelEdit(id);
        }
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
        this.doc = structuredClone(doc);
        this.selectedIds.clear();
        this.selectedEdgeId = null;
        this.board.selectEdge(null);
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
        this.refreshBottomBar();
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
        this.selectedIds = new Set([id]);
        this.selectedEdgeId = null;
        this.renderAll();
        this.refreshBottomBar();
        this.commit();
        return id;
    }

    // ─── Editing ───

    private startTextEdit(id: string, body: HTMLElement): void {
        if (this.editingId === id) return;

        const node = this.nodeById(id);
        if (node === undefined || node.type !== 'text') return;
        this.editingId = id;

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

        openLabelEdit(this.board.stage, {
            className: 'canvas-group-label-edit',
            value: group.label ?? '',
            placeholder: t('groupLabel'),
            left: group.x + 8,
            top: group.y - 22,
            onCommit: (next) => {
                const now = this.nodeById(groupId);
                if (now === undefined || now.type !== 'group' || (now.label ?? '') === next) return;
                this.doc = withGroupLabel(this.doc, groupId, next);
                this.renderAll();
                this.commit();
            }
        });
    }

    /** Label input at the edge's midpoint. */
    private startEdgeLabelEdit(edgeId: string): void {
        const edge = this.doc.edges.find((e) => e.id === edgeId);
        const mid = this.board.edgeMidpoint(edgeId);
        if (edge === undefined || mid === null) return;

        openLabelEdit(this.board.stage, {
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
}
