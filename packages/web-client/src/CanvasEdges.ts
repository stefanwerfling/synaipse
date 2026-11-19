import type {CanvasDocument, CanvasSide} from '@synaipse/core';
import {clear} from './Dom.js';
import {anchorFor, bezierMidpoint, bezierPathD, computeBounds, resolveColor, type AnchorPoint} from './CanvasGeometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface EdgeRenderState {
    selectedEdgeId: string | null;
    /** Endpoint handles are drawn on the selected edge only when editable. */
    editable: boolean;
    /** An endpoint of an existing edge follows the cursor (reroute drag). */
    handleDrag: {edgeId: string; endpoint: 'from' | 'to'; x: number; y: number} | null;
    /** A new edge being drawn from an anchor to the cursor. */
    draft: {fromNode: string; fromSide: CanvasSide; x: number; y: number} | null;
}

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
};

const arrowDefs = (): SVGDefsElement => {
    const defs = svg('defs', {});
    const marker = svg('marker', {
        id: 'canvas-arrow',
        viewBox: '0 0 10 10',
        refX: 9,
        refY: 5,
        markerWidth: 6,
        markerHeight: 6,
        orient: 'auto-start-reverse'
    });
    marker.appendChild(svg('path', {d: 'M0,0 L10,5 L0,10 z', fill: 'currentColor'}));
    defs.appendChild(marker);
    return defs;
};

/**
 * Pill plus text at the edge midpoint. The pill sits behind the text so
 * the label reads cleanly where it crosses the line; its width is
 * estimated from the character count (SVG has no cheap synchronous
 * text metrics before layout).
 */
const edgeLabel = (group: SVGGElement, label: string, mid: {x: number; y: number}, color: string): void => {
    const padX = 7;
    const charW = 6.6;
    const w = label.length * charW + padX * 2;
    const h = 18;

    const pill = svg('rect', {x: mid.x - w / 2, y: mid.y - h / 2, width: w, height: h, rx: 9, 'pointer-events': 'none'});
    pill.classList.add('canvas-edge-label-bg');
    group.appendChild(pill);

    const text = svg('text', {
        x: mid.x,
        y: mid.y,
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        fill: color,
        'font-size': 11,
        'font-weight': 600,
        'pointer-events': 'none'
    });
    text.classList.add('canvas-edge-label');
    text.textContent = label;
    group.appendChild(text);
};

/**
 * Redraw every edge of `doc` into `host` (plan P7 / D2): routed bezier
 * with a wide invisible hitbox, arrow markers, label pill, endpoint
 * handles on the selected edge, and the draft line of an edge being
 * drawn. The SVG is sized to the node bounds plus a 100px margin.
 */
export const renderEdges = (host: SVGSVGElement, doc: CanvasDocument, state: EdgeRenderState): void => {
    clear(host);

    const bounds = computeBounds(doc.nodes);
    const width = bounds.maxX - bounds.minX + 200;
    const height = bounds.maxY - bounds.minY + 200;
    host.setAttribute('viewBox', `${bounds.minX - 100} ${bounds.minY - 100} ${width} ${height}`);
    host.style.left = `${bounds.minX - 100}px`;
    host.style.top = `${bounds.minY - 100}px`;
    host.style.width = `${width}px`;
    host.style.height = `${height}px`;

    host.appendChild(arrowDefs());

    const nodesById = new Map(doc.nodes.map((n) => [n.id, n]));

    for (const edge of doc.edges) {
        const from = nodesById.get(edge.fromNode);
        const to = nodesById.get(edge.toNode);
        if (from === undefined || to === undefined) continue;
        if (from.type === 'group' || to.type === 'group') continue;

        // A dragged endpoint follows the cursor instead of its anchor.
        const dragging = state.handleDrag !== null && state.handleDrag.edgeId === edge.id ? state.handleDrag : null;

        const a: AnchorPoint = dragging?.endpoint === 'from'
            ? {x: dragging.x, y: dragging.y}
            : anchorFor(from, edge.fromSide, to);
        const b: AnchorPoint = dragging?.endpoint === 'to'
            ? {x: dragging.x, y: dragging.y}
            : anchorFor(to, edge.toSide, from);
        const color = resolveColor(edge.color, 'var(--accent)');
        const isSelected = edge.id === state.selectedEdgeId;

        const group = svg('g', {});
        group.classList.add('canvas-edge-group');
        if (isSelected) group.classList.add('selected');
        group.dataset.edgeId = edge.id;

        const pathD = bezierPathD(a, b);

        // Invisible thick curve under the visible one so the click hitbox
        // is easy to hit even at ~1.5px stroke widths.
        const hitbox = svg('path', {d: pathD, fill: 'none', stroke: 'transparent', 'stroke-width': 16, 'pointer-events': 'stroke'});
        hitbox.classList.add('canvas-edge-hitbox');
        group.appendChild(hitbox);

        const line = svg('path', {
            d: pathD,
            fill: 'none',
            stroke: color,
            'stroke-width': isSelected ? '2.5' : '1.75',
            'stroke-linecap': 'round',
            'pointer-events': 'none'
        });
        line.style.color = color;
        if (edge.toEnd !== 'none') line.setAttribute('marker-end', 'url(#canvas-arrow)');
        if (edge.fromEnd === 'arrow') line.setAttribute('marker-start', 'url(#canvas-arrow)');
        line.classList.add('canvas-edge');
        group.appendChild(line);

        if (edge.label !== undefined && edge.label.length > 0) {
            edgeLabel(group, edge.label, bezierMidpoint(a, b), color);
        }

        host.appendChild(group);

        // Endpoint handles stack on top of the arrow marker so either end
        // can be grabbed even when it terminates near a card.
        if (isSelected && state.editable) {
            for (const endpoint of ['from', 'to'] as const) {
                const p = endpoint === 'from' ? a : b;
                const dot = svg('circle', {cx: p.x, cy: p.y, r: 6});
                dot.classList.add('canvas-edge-handle');
                dot.dataset.edgeId = edge.id;
                dot.dataset.endpoint = endpoint;
                host.appendChild(dot);
            }
        }
    }

    const draft = state.draft;
    if (draft === null) return;

    const from = nodesById.get(draft.fromNode);
    if (from === undefined || from.type === 'group') return;

    const start = anchorFor(from, draft.fromSide, {x: draft.x, y: draft.y, width: 0, height: 0});
    const line = svg('line', {x1: start.x, y1: start.y, x2: draft.x, y2: draft.y, 'pointer-events': 'none'});
    line.classList.add('canvas-edge-draft');
    host.appendChild(line);
};

/** Label midpoint of an edge as currently drawn; null when an end is missing or a group. */
export const edgeMidpoint = (doc: CanvasDocument, edgeId: string): {x: number; y: number} | null => {
    const edge = doc.edges.find((e) => e.id === edgeId);
    if (edge === undefined) return null;
    const from = doc.nodes.find((n) => n.id === edge.fromNode);
    const to = doc.nodes.find((n) => n.id === edge.toNode);
    if (from === undefined || to === undefined || from.type === 'group' || to.type === 'group') return null;
    return bezierMidpoint(anchorFor(from, edge.fromSide, to), anchorFor(to, edge.toSide, from));
};
