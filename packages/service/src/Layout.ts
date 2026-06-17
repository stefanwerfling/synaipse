import {createHash} from 'node:crypto';
import {detectCommunities, type CommunityGraphEdge, type CommunityGraphNode} from './Communities.js';

/**
 * Deterministic, server-pre-computed graph layout for the "Atlas" view.
 *
 * The browser-side force simulations (Cytoscape, three.js) collapse around
 * 5-10k nodes — they keep recomputing positions every frame. This module
 * runs Louvain community detection once on the full graph, lays out each
 * community in its own tile, and inside each tile drops nodes onto a
 * sunflower spiral. The result is a {nodeId → {x, y}} map the client just
 * blits onto a canvas — no animation, no frame-by-frame work.
 */

export interface LayoutNode {
    id: string;
    x: number;
    y: number;
    community: number;
    /** Degree (in + out) for sizing/colour. */
    degree: number;
}

export interface LayoutCommunity {
    id: number;
    size: number;
    /** Tile centre. */
    cx: number;
    cy: number;
    /** Tile radius (half-edge). */
    radius: number;
}

export interface GraphLayout {
    /** SHA-1 of the source graph; clients use this to bust their position cache. */
    hash: string;
    nodes: LayoutNode[];
    communities: LayoutCommunity[];
    /** Logical canvas dimensions (positions stay inside [0..bounds] in both axes). */
    bounds: {width: number; height: number};
    modularity: number;
}

const TILE_PADDING = 80;
const NODE_SPACING = 28;
/** Phi-based angle increment that makes nodes spread evenly on a spiral. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const layoutCommunityNodes = (
    nodeIds: readonly string[],
    cx: number,
    cy: number
): Array<{id: string; x: number; y: number}> => {
    return nodeIds.map((id, i) => {
        const r = NODE_SPACING * Math.sqrt(i + 1);
        const theta = i * GOLDEN_ANGLE;
        return {id, x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta)};
    });
};

/** Pack communities into a near-square grid, biggest tiles first. */
const layoutCommunityGrid = (
    sizes: readonly number[]
): Array<{cx: number; cy: number; radius: number}> => {
    const radii = sizes.map((n) => NODE_SPACING * Math.sqrt(n) + TILE_PADDING);
    const cols = Math.max(1, Math.ceil(Math.sqrt(sizes.length)));
    const tiles: Array<{cx: number; cy: number; radius: number}> = [];

    let row = 0;
    let col = 0;
    let rowHeight = 0;
    let xCursor = 0;
    let yCursor = 0;

    for (let i = 0; i < sizes.length; i += 1) {
        const r = radii[i] ?? TILE_PADDING;
        const diameter = r * 2;

        if (col >= cols) {
            yCursor += rowHeight;
            xCursor = 0;
            rowHeight = 0;
            row += 1;
            col = 0;
        }

        const cx = xCursor + r;
        const cy = yCursor + r;
        tiles.push({cx, cy, radius: r});

        xCursor += diameter;
        rowHeight = Math.max(rowHeight, diameter);
        col += 1;
    }

    void row;
    return tiles;
};

const computeHash = (
    nodes: readonly CommunityGraphNode[],
    edges: readonly CommunityGraphEdge[]
): string => {
    const hash = createHash('sha1');
    const nodeIds = nodes.map((n) => n.id).sort();
    for (const id of nodeIds) hash.update(`${id}\n`);
    hash.update('---\n');
    const edgeStrings = edges
        .map((e) => `${e.from}|${e.to}|${e.weight ?? 1}`)
        .sort();
    for (const e of edgeStrings) hash.update(`${e}\n`);
    return hash.digest('hex');
};

export interface GraphInput {
    nodes: ReadonlyArray<CommunityGraphNode & {tags?: string[]}>;
    edges: ReadonlyArray<CommunityGraphEdge>;
}

export const computeLayout = (input: GraphInput): GraphLayout => {
    const hash = computeHash(input.nodes, input.edges);

    if (input.nodes.length === 0) {
        return {hash, nodes: [], communities: [], bounds: {width: 0, height: 0}, modularity: 0};
    }

    const communities = detectCommunities(input.nodes, input.edges);

    // Group node ids by community, biggest community first.
    const byCommunity = new Map<number, string[]>();
    for (const node of input.nodes) {
        const c = communities.partition.get(node.id) ?? 0;
        let arr = byCommunity.get(c);
        if (arr === undefined) {
            arr = [];
            byCommunity.set(c, arr);
        }
        arr.push(node.id);
    }

    const sorted = [...byCommunity.entries()].sort((a, b) => b[1].length - a[1].length);
    const tiles = layoutCommunityGrid(sorted.map(([, arr]) => arr.length));

    const positions = new Map<string, {x: number; y: number; community: number}>();
    const communityRecords: LayoutCommunity[] = [];

    sorted.forEach(([communityId, nodeIds], idx) => {
        const tile = tiles[idx];
        if (tile === undefined) return;

        communityRecords.push({
            id: communityId,
            size: nodeIds.length,
            cx: tile.cx,
            cy: tile.cy,
            radius: tile.radius
        });

        const placed = layoutCommunityNodes(nodeIds, tile.cx, tile.cy);
        for (const p of placed) {
            positions.set(p.id, {x: p.x, y: p.y, community: communityId});
        }
    });

    // Degree counts.
    const degreeById = new Map<string, number>();
    for (const e of input.edges) {
        degreeById.set(e.from, (degreeById.get(e.from) ?? 0) + 1);
        if (e.from !== e.to) degreeById.set(e.to, (degreeById.get(e.to) ?? 0) + 1);
    }

    const layoutNodes: LayoutNode[] = input.nodes.map((n) => {
        const pos = positions.get(n.id) ?? {x: 0, y: 0, community: 0};
        return {
            id: n.id,
            x: pos.x,
            y: pos.y,
            community: pos.community,
            degree: degreeById.get(n.id) ?? 0
        };
    });

    const maxX = Math.max(0, ...layoutNodes.map((n) => n.x));
    const maxY = Math.max(0, ...layoutNodes.map((n) => n.y));

    return {
        hash,
        nodes: layoutNodes,
        communities: communityRecords,
        bounds: {width: maxX + TILE_PADDING, height: maxY + TILE_PADDING},
        modularity: communities.modularity
    };
};