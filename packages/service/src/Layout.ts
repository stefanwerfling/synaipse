import {createHash} from 'node:crypto';
import {detectCommunities, type CommunityGraphEdge, type CommunityGraphNode} from '@synaipse/core/louvain';

/**
 * Deterministic, server-pre-computed graph layout for the 2D view of
 * large vaults (from a few thousand notes, see web Graph.ts).
 *
 * The browser-side force simulations (Cytoscape, three.js) collapse around
 * 5-10k nodes — they keep recomputing positions every frame. This module
 * runs Louvain community detection once on the full graph, lays out each
 * community in its own round tile (tiles circle-packed, biggest in the
 * middle), and inside each tile drops nodes onto a sunflower spiral,
 * best-connected first. The result is a {nodeId → {x, y}} map the client just
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
    /** Tile radius (spiral extent plus gap). */
    radius: number;
    /** The group of notes without a link to another note (not a Louvain community). */
    unlinked?: boolean;
}

export interface InterCommunityEdge {
    from: number;
    to: number;
    /** Number of inter-community edges aggregated into this one. */
    weight: number;
}

export interface GraphLayout {
    /** SHA-1 of the source graph; clients use this to bust their position cache. */
    hash: string;
    nodes: LayoutNode[];
    communities: LayoutCommunity[];
    /** Aggregated edges between communities, used at low zoom levels. */
    interCommunityEdges: InterCommunityEdge[];
    /** Logical canvas dimensions (positions stay inside [0..bounds] in both axes). */
    bounds: {width: number; height: number};
    modularity: number;
}

/** Distance between neighbouring notes on a community's sunflower spiral. */
const NODE_SPACING = 28;
/** Free space around a community: a fixed part plus a share of its extent. */
const TILE_GAP = 24;
const TILE_GAP_SHARE = 0.08;
/** Margin between the packed communities and the bounds. */
const BOUNDS_MARGIN = 80;
/** Phi-based angle increment that makes nodes spread evenly on a spiral. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Radius of a community's tile: its spiral plus the gap around it. */
export const tileRadius = (size: number): number => {
    const extent = NODE_SPACING * Math.sqrt(Math.max(1, size));
    return extent + TILE_GAP + extent * TILE_GAP_SHARE;
};

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

export interface PackCircle {
    r: number;
    x: number;
    y: number;
}

interface ChainNode {
    c: PackCircle;
    next: ChainNode;
    previous: ChainNode;
}

/** Put `c` tangent to `a` and `b` (on the side that keeps the chain counter-clockwise). */
const placeTangent = (b: PackCircle, a: PackCircle, c: PackCircle): void => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d2 = dx * dx + dy * dy;

    if (d2 === 0) {
        c.x = a.x + c.r;
        c.y = a.y;
        return;
    }

    const a2 = (a.r + c.r) ** 2;
    const b2 = (b.r + c.r) ** 2;

    if (a2 > b2) {
        const x = (d2 + b2 - a2) / (2 * d2);
        const y = Math.sqrt(Math.max(0, b2 / d2 - x * x));
        c.x = b.x - x * dx - y * dy;
        c.y = b.y - x * dy + y * dx;
    } else {
        const x = (d2 + a2 - b2) / (2 * d2);
        const y = Math.sqrt(Math.max(0, a2 / d2 - x * x));
        c.x = a.x + x * dx - y * dy;
        c.y = a.y + x * dy + y * dx;
    }
};

const intersects = (a: PackCircle, b: PackCircle): boolean => {
    const dr = a.r + b.r - 1e-6;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return dr > 0 && dr * dr > dx * dx + dy * dy;
};

/** Squared distance from the origin of the weighted midpoint of a chain link. */
const linkScore = (node: ChainNode): number => {
    const a = node.c;
    const b = node.next.c;
    const ab = a.r + b.r;
    const x = (a.x * b.r + b.x * a.r) / ab;
    const y = (a.y * b.r + b.y * a.r) / ab;
    return x * x + y * y;
};

/**
 * Pack circles tightly around the origin, in the given order (front-chain
 * packing after Wang et al. 2006, as in d3-hierarchy's packSiblings).
 * Each circle is placed tangent to the pair of the front chain closest to
 * the origin, so the result grows roughly round: put the big ones first
 * and they end up in the middle. Sets x/y in place.
 */
export const packCircles = (circles: PackCircle[]): void => {
    const n = circles.length;
    if (n === 0) return;

    const first = circles[0] as PackCircle;
    first.x = 0;
    first.y = 0;
    if (n === 1) return;

    const second = circles[1] as PackCircle;
    first.x = -second.r;
    second.x = first.r;
    second.y = 0;
    if (n === 2) return;

    const third = circles[2] as PackCircle;
    placeTangent(second, first, third);

    const node = (c: PackCircle): ChainNode => {
        const self = {c} as ChainNode;
        self.next = self;
        self.previous = self;
        return self;
    };

    let a = node(first);
    let b = node(second);
    const c3 = node(third);
    a.next = c3.previous = b;
    b.next = a.previous = c3;
    c3.next = b.previous = a;

    pack: for (let i = 3; i < n; i += 1) {
        const circle = circles[i] as PackCircle;
        placeTangent(a.c, b.c, circle);
        const c = node(circle);

        // Walk the chain from both ends; on overlap drop the links between
        // and retry this circle against the new pair.
        let j = b.next;
        let k = a.previous;
        let sj = b.c.r;
        let sk = a.c.r;

        do {
            if (sj <= sk) {
                if (intersects(j.c, c.c)) {
                    b = j;
                    a.next = b;
                    b.previous = a;
                    i -= 1;
                    continue pack;
                }
                sj += j.c.r;
                j = j.next;
            } else {
                if (intersects(k.c, c.c)) {
                    a = k;
                    a.next = b;
                    b.previous = a;
                    i -= 1;
                    continue pack;
                }
                sk += k.c.r;
                k = k.previous;
            }
        } while (j !== k.next);

        // Insert c between a and b, then move to the link closest to the origin.
        c.previous = a;
        c.next = b;
        a.next = c;
        b.previous = c;
        b = c;

        let best = linkScore(a);
        let cursor = c.next;

        while (cursor !== b) {
            const score = linkScore(cursor);
            if (score < best) {
                a = cursor;
                best = score;
            }
            cursor = cursor.next;
        }

        b = a.next;
    }
};

/**
 * Tiles for the communities, in the given order (biggest first): packed
 * as circles and shifted so everything sits inside [BOUNDS_MARGIN, ...].
 */
const layoutCommunityTiles = (
    sizes: readonly number[]
): Array<{cx: number; cy: number; radius: number}> => {
    const circles: PackCircle[] = sizes.map((size) => ({r: tileRadius(size), x: 0, y: 0}));
    packCircles(circles);

    let minX = Infinity;
    let minY = Infinity;
    for (const c of circles) {
        if (c.x - c.r < minX) minX = c.x - c.r;
        if (c.y - c.r < minY) minY = c.y - c.r;
    }

    return circles.map((c) => ({cx: c.x - minX + BOUNDS_MARGIN, cy: c.y - minY + BOUNDS_MARGIN, radius: c.r}));
};

/**
 * Part of the layout hash (and so of the HTTP ETag). Bump it whenever the
 * algorithm's output changes for the same graph, or browsers keep showing
 * the old layout via 304. 2: Louvain fixes (move gain, modularity, self-loops).
 * 3: circle packing, unlinked notes in one group, hubs in the middle.
 */
export const LAYOUT_ALGORITHM_VERSION = 3;

const computeHash = (
    nodes: readonly CommunityGraphNode[],
    edges: readonly CommunityGraphEdge[]
): string => {
    const hash = createHash('sha1');
    hash.update(`layout-v${LAYOUT_ALGORITHM_VERSION}\n`);
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
        return {hash, nodes: [], communities: [], interCommunityEdges: [], bounds: {width: 0, height: 0}, modularity: 0};
    }

    const communities = detectCommunities(input.nodes, input.edges);

    const degreeById = new Map<string, number>();
    const linked = new Set<string>();
    for (const e of input.edges) {
        degreeById.set(e.from, (degreeById.get(e.from) ?? 0) + 1);
        if (e.from === e.to) continue;
        degreeById.set(e.to, (degreeById.get(e.to) ?? 0) + 1);
        linked.add(e.from);
        linked.add(e.to);
    }

    // Notes without a link to another note are each their own Louvain
    // community; as single tiles they used to fill a huge raster. They
    // share one group instead (an extra id, it changes no modularity).
    let unlinkedId = 0;
    for (const c of communities.partition.values()) if (c >= unlinkedId) unlinkedId = c + 1;

    const communityOf = (id: string): number => (linked.has(id) ? communities.partition.get(id) ?? unlinkedId : unlinkedId);

    const byCommunity = new Map<number, string[]>();
    for (const node of input.nodes) {
        const c = communityOf(node.id);
        let arr = byCommunity.get(c);
        if (arr === undefined) {
            arr = [];
            byCommunity.set(c, arr);
        }
        arr.push(node.id);
    }

    // Biggest community first, so the packing puts it in the middle; the
    // unlinked group last, at the edge. Ties by id keep it deterministic.
    const unlinked = byCommunity.get(unlinkedId);
    byCommunity.delete(unlinkedId);
    const sorted = [...byCommunity.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
    if (unlinked !== undefined) sorted.push([unlinkedId, unlinked]);

    const tiles = layoutCommunityTiles(sorted.map(([, arr]) => arr.length));

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
            radius: tile.radius,
            ...(communityId === unlinkedId ? {unlinked: true} : {})
        });

        // Best-connected notes at the centre of the spiral.
        const ordered = [...nodeIds].sort((x, y) => (degreeById.get(y) ?? 0) - (degreeById.get(x) ?? 0));
        const placed = layoutCommunityNodes(ordered, tile.cx, tile.cy);
        for (const p of placed) {
            positions.set(p.id, {x: p.x, y: p.y, community: communityId});
        }
    });

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

    // Plain loop — `Math.max(0, ...arr)` blows the argument stack at ~150k
    // entries, so we can't spread here even though the shape is tempting.
    let maxX = 0;
    let maxY = 0;
    for (const n of layoutNodes) {
        if (n.x > maxX) maxX = n.x;
        if (n.y > maxY) maxY = n.y;
    }

    // Aggregate edges between communities so the client can show a thin
    // skeleton at zoomed-out level (50 super-nodes + their links) instead
    // of all 17k individual lines.
    const interEdges = new Map<string, InterCommunityEdge>();

    for (const e of input.edges) {
        if (e.from === e.to) continue;
        const ca = communityOf(e.from);
        const cb = communityOf(e.to);
        if (ca === cb) continue;

        const lo = Math.min(ca, cb);
        const hi = Math.max(ca, cb);
        const key = `${lo}|${hi}`;
        const existing = interEdges.get(key);
        if (existing === undefined) {
            interEdges.set(key, {from: lo, to: hi, weight: 1});
        } else {
            existing.weight += 1;
        }
    }

    return {
        hash,
        nodes: layoutNodes,
        communities: communityRecords,
        interCommunityEdges: [...interEdges.values()],
        bounds: {width: maxX + BOUNDS_MARGIN, height: maxY + BOUNDS_MARGIN},
        modularity: communities.modularity
    };
};