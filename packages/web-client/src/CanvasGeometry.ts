import type {CanvasDocument, CanvasEdge, CanvasNode, CanvasSide} from '@synaipse/core';

/**
 * Pure part of the canvas (plan P7 / D2): grid, colours, edge routing
 * and the immutable document operations behind every canvas mutation.
 */

export const SIDES: readonly CanvasSide[] = ['top', 'right', 'bottom', 'left'];

export const MIN_CARD_W = 100;
export const MIN_CARD_H = 60;
export const DEFAULT_TEXT_CARD_W = 260;
export const DEFAULT_TEXT_CARD_H = 140;

// Position + size snap grid for cards and groups. 20px matches Obsidian
// Canvas's default so notes moved between the two look consistent.
// Alt (option) held during drag/resize bypasses the snap for pixel-
// precise placement.
export const GRID_STEP = 20;

export const snap = (v: number): number => Math.round(v / GRID_STEP) * GRID_STEP;

// Muted, desaturated take on Obsidian's 1..6 palette. The stored value is
// still the preset id ("1".."6"), so files round-trip to Obsidian fine —
// only our rendered hue changes. Saturated primaries read like a crayon
// drawing; these dusty tones read like a design tool.
export const COLOR_PRESETS: Readonly<Record<string, string>> = {
    '1': '#cf8080', // rose
    '2': '#cf9a6a', // clay
    '3': '#c4b06a', // gold
    '4': '#7fae83', // sage
    '5': '#6f9fc4', // steel blue
    '6': '#a189c2'  // lavender
};

/**
 * Obsidian's own color palette order — matches the swatches in Obsidian's
 * canvas UI so users transferring back and forth see the same visual
 * shorthand. Presets 1..6, followed by the "clear" pseudo-option.
 */
export const COLOR_PRESET_ORDER: readonly string[] = ['1', '2', '3', '4', '5', '6'];

export type ArrowStyle = 'to' | 'both' | 'none';

export const arrowStyleOf = (edge: {fromEnd?: 'none' | 'arrow'; toEnd?: 'none' | 'arrow'}): ArrowStyle => {
    const from = edge.fromEnd === 'arrow';
    const to = edge.toEnd !== 'none';
    if (from && to) return 'both';
    if (!to) return 'none';
    return 'to';
};

/** A preset id ("1".."6") to its hue; any other value is taken as a CSS colour. */
export const resolveColor = (raw: string | undefined, fallback: string): string => {
    if (raw === undefined) return fallback;
    return COLOR_PRESETS[raw] ?? raw;
};

/**
 * Short random ID. Obsidian uses 16-hex-char but any URL-safe string
 * survives round-trips through parseCanvas, so keep it simple.
 */
export const genId = (): string => {
    const arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** Anything with a position and size (nodes, cursor stand-ins). */
export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface Rect extends Box {
    id: string;
}

/**
 * Every node whose bounding box lies fully inside `group`'s rect (edge-
 * inclusive). Used by the group-drag path so moving a container carries
 * its children — including nested groups, since a sub-group's rect is
 * geometrically inside the outer group's rect too.
 */
export function nodesInsideGroup<T extends Rect>(group: Rect, all: readonly T[]): T[] {
    const gx2 = group.x + group.width;
    const gy2 = group.y + group.height;
    return all.filter((n) =>
        n.id !== group.id &&
        n.x >= group.x &&
        n.y >= group.y &&
        n.x + n.width <= gx2 &&
        n.y + n.height <= gy2
    );
}

// ─── Document operations (immutable: each returns a new document) ───

const withColor = <T extends {color?: string}>(item: T, preset: string | undefined): T => {
    const patched = {...item};
    if (preset === undefined) {
        delete patched.color;
    } else {
        patched.color = preset;
    }
    return patched;
};

/** Optional string field set to `value`, or removed when `value` is empty. */
const withLabel = <T extends {label?: string}>(item: T, value: string): T => {
    const patched = {...item};
    if (value.length === 0) {
        delete patched.label;
    } else {
        patched.label = value;
    }
    return patched;
};

const mapNode = (doc: CanvasDocument, id: string, fn: (node: CanvasNode) => CanvasNode): CanvasDocument => {
    const idx = doc.nodes.findIndex((n) => n.id === id);
    const current = doc.nodes[idx];
    if (current === undefined) return doc;
    const nodes = doc.nodes.slice();
    nodes[idx] = fn(current);
    return {nodes, edges: doc.edges};
};

const mapEdge = (doc: CanvasDocument, id: string, fn: (edge: CanvasEdge) => CanvasEdge): CanvasDocument => {
    const idx = doc.edges.findIndex((e) => e.id === id);
    const current = doc.edges[idx];
    if (current === undefined) return doc;
    const edges = doc.edges.slice();
    edges[idx] = fn(current);
    return {nodes: doc.nodes, edges};
};

/** Set (or with `undefined` clear) the colour of these nodes. */
export const withNodesColor = (doc: CanvasDocument, ids: readonly string[], preset: string | undefined): CanvasDocument => {
    const paint = new Set(ids);
    return {
        nodes: doc.nodes.map((node) => paint.has(node.id) ? withColor(node, preset) : node),
        edges: doc.edges
    };
};

export const withEdgeColor = (doc: CanvasDocument, id: string, preset: string | undefined): CanvasDocument =>
    mapEdge(doc, id, (edge) => withColor(edge, preset));

export const withEdgeArrow = (doc: CanvasDocument, id: string, style: ArrowStyle): CanvasDocument =>
    mapEdge(doc, id, (edge) => {
        const patched = {...edge};
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
        return patched;
    });

export const withEdgeLabel = (doc: CanvasDocument, id: string, label: string): CanvasDocument =>
    mapEdge(doc, id, (edge) => withLabel(edge, label));

/** Group label; text cards and other nodes are left alone. */
export const withGroupLabel = (doc: CanvasDocument, id: string, label: string): CanvasDocument =>
    mapNode(doc, id, (node) => node.type === 'group' ? withLabel(node, label) : node);

export const withCardText = (doc: CanvasDocument, id: string, text: string): CanvasDocument =>
    mapNode(doc, id, (node) => node.type === 'text' ? {...node, text} : node);

/** Remove these nodes and every edge touching one of them. */
export const withoutNodes = (doc: CanvasDocument, ids: readonly string[]): CanvasDocument => {
    const drop = new Set(ids);
    return {
        nodes: doc.nodes.filter((n) => !drop.has(n.id)),
        edges: doc.edges.filter((e) => !drop.has(e.fromNode) && !drop.has(e.toNode))
    };
};

export const withoutEdge = (doc: CanvasDocument, id: string): CanvasDocument => ({
    nodes: doc.nodes,
    edges: doc.edges.filter((e) => e.id !== id)
});

/**
 * Point one end of an edge at `newNode`. A move that would make the edge
 * a self-loop is silently rejected (the document comes back unchanged).
 */
export const withRerouted = (doc: CanvasDocument, id: string, endpoint: 'from' | 'to', newNode: string): CanvasDocument =>
    mapEdge(doc, id, (edge) => {
        if (endpoint === 'from' && newNode === edge.toNode) return edge;
        if (endpoint === 'to' && newNode === edge.fromNode) return edge;
        return endpoint === 'from' ? {...edge, fromNode: newNode} : {...edge, toNode: newNode};
    });
