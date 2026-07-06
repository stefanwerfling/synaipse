/**
 * Obsidian-compatible canvas JSON format (documented at
 * https://jsoncanvas.org/). We use the same shape so vaults stay
 * interchangeable — a `.canvas` file written here opens in Obsidian and
 * vice versa. Field names and semantics mirror Obsidian's Canvas plugin.
 */

export type CanvasNodeType = 'text' | 'file' | 'link' | 'group';

/**
 * Side of a card an edge attaches to. `undefined` = auto-pick nearest.
 */
export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';

/**
 * Obsidian preset "1".."6" (red, orange, yellow, green, cyan, purple) OR
 * a raw hex color like "#a1b2c3". Kept as a string so unknown presets
 * survive round-trips instead of getting dropped.
 */
export type CanvasColor = string;

export interface CanvasNodeBase {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color?: CanvasColor;
}

export interface CanvasTextNode extends CanvasNodeBase {
    type: 'text';
    text: string;
}

export interface CanvasFileNode extends CanvasNodeBase {
    type: 'file';
    file: string;
    subpath?: string;
}

export interface CanvasLinkNode extends CanvasNodeBase {
    type: 'link';
    url: string;
}

export interface CanvasGroupNode extends CanvasNodeBase {
    type: 'group';
    label?: string;
    background?: string;
    backgroundStyle?: string;
}

export type CanvasNode =
    | CanvasTextNode
    | CanvasFileNode
    | CanvasLinkNode
    | CanvasGroupNode;

export interface CanvasEdge {
    id: string;
    fromNode: string;
    toNode: string;
    fromSide?: CanvasSide;
    toSide?: CanvasSide;
    fromEnd?: 'none' | 'arrow';
    toEnd?: 'none' | 'arrow';
    color?: CanvasColor;
    label?: string;
}

export interface CanvasDocument {
    nodes: CanvasNode[];
    edges: CanvasEdge[];
}

export const emptyCanvas = (): CanvasDocument => ({nodes: [], edges: []});

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const asNumber = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const asString = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined;

const asSide = (v: unknown): CanvasSide | undefined => {
    if (v === 'top' || v === 'right' || v === 'bottom' || v === 'left') return v;
    return undefined;
};

const parseNode = (raw: unknown): CanvasNode | null => {
    if (!isRecord(raw)) return null;

    const id = asString(raw.id);
    const type = asString(raw.type);
    const x = asNumber(raw.x);
    const y = asNumber(raw.y);
    const width = asNumber(raw.width);
    const height = asNumber(raw.height);

    if (id === undefined || type === undefined) return null;
    if (x === undefined || y === undefined) return null;
    if (width === undefined || height === undefined) return null;

    const base: CanvasNodeBase = {id, x, y, width, height};
    const color = asString(raw.color);
    if (color !== undefined) base.color = color;

    if (type === 'text') {
        const text = asString(raw.text);
        if (text === undefined) return null;
        return {...base, type: 'text', text};
    }

    if (type === 'file') {
        const file = asString(raw.file);
        if (file === undefined) return null;
        const subpath = asString(raw.subpath);
        return {...base, type: 'file', file, ...(subpath !== undefined ? {subpath} : {})};
    }

    if (type === 'link') {
        const url = asString(raw.url);
        if (url === undefined) return null;
        return {...base, type: 'link', url};
    }

    if (type === 'group') {
        const label = asString(raw.label);
        const background = asString(raw.background);
        const backgroundStyle = asString(raw.backgroundStyle);
        return {
            ...base,
            type: 'group',
            ...(label !== undefined ? {label} : {}),
            ...(background !== undefined ? {background} : {}),
            ...(backgroundStyle !== undefined ? {backgroundStyle} : {})
        };
    }

    return null;
};

const parseEdge = (raw: unknown): CanvasEdge | null => {
    if (!isRecord(raw)) return null;

    const id = asString(raw.id);
    const fromNode = asString(raw.fromNode);
    const toNode = asString(raw.toNode);

    if (id === undefined || fromNode === undefined || toNode === undefined) return null;

    const edge: CanvasEdge = {id, fromNode, toNode};
    const fromSide = asSide(raw.fromSide);
    const toSide = asSide(raw.toSide);
    if (fromSide !== undefined) edge.fromSide = fromSide;
    if (toSide !== undefined) edge.toSide = toSide;

    const fromEnd = raw.fromEnd;
    const toEnd = raw.toEnd;
    if (fromEnd === 'none' || fromEnd === 'arrow') edge.fromEnd = fromEnd;
    if (toEnd === 'none' || toEnd === 'arrow') edge.toEnd = toEnd;

    const color = asString(raw.color);
    const label = asString(raw.label);
    if (color !== undefined) edge.color = color;
    if (label !== undefined) edge.label = label;

    return edge;
};

/**
 * Parse a `.canvas` file body into a normalized document. Malformed
 * nodes/edges are silently dropped rather than throwing — an Obsidian
 * user might have future fields we don't understand, and losing one
 * card shouldn't take out the whole board.
 */
export const parseCanvas = (raw: string): CanvasDocument => {
    if (raw.trim().length === 0) return emptyCanvas();

    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        return emptyCanvas();
    }

    if (!isRecord(json)) return emptyCanvas();

    const rawNodes = Array.isArray(json.nodes) ? json.nodes : [];
    const rawEdges = Array.isArray(json.edges) ? json.edges : [];

    const nodes: CanvasNode[] = [];
    for (const n of rawNodes) {
        const parsed = parseNode(n);
        if (parsed !== null) nodes.push(parsed);
    }

    const edges: CanvasEdge[] = [];
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const e of rawEdges) {
        const parsed = parseEdge(e);
        // Drop dangling edges — Obsidian tolerates them but they're
        // just visual noise in our renderer.
        if (parsed !== null && nodeIds.has(parsed.fromNode) && nodeIds.has(parsed.toNode)) {
            edges.push(parsed);
        }
    }

    return {nodes, edges};
};

/**
 * Serialize back to Obsidian's canonical `.canvas` layout: 1-space
 * indent, `nodes` before `edges`. Matches Obsidian output so diffs
 * stay small when the same file is edited by both apps.
 */
export const serializeCanvas = (doc: CanvasDocument): string => {
    return JSON.stringify({nodes: doc.nodes, edges: doc.edges}, null, '\t');
};