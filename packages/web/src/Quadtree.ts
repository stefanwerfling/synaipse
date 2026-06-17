/**
 * Region quadtree over (x, y, payload) points. O(log n) nearest-point query
 * for hit-testing a graph view with thousands of nodes — the previous linear
 * scan over `nodes` per mousemove turned into a measurable hot path once the
 * vault crossed a few thousand entries.
 */

export interface QuadtreePoint<T> {
    x: number;
    y: number;
    payload: T;
}

interface Bounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

const MAX_POINTS_PER_NODE = 16;
const MAX_DEPTH = 12;

interface Node<T> {
    bounds: Bounds;
    depth: number;
    points: QuadtreePoint<T>[];
    children: [Node<T>, Node<T>, Node<T>, Node<T>] | null;
}

const inside = (b: Bounds, x: number, y: number): boolean =>
    x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;

const rectDist = (b: Bounds, x: number, y: number): number => {
    const dx = x < b.minX ? b.minX - x : x > b.maxX ? x - b.maxX : 0;
    const dy = y < b.minY ? b.minY - y : y > b.maxY ? y - b.maxY : 0;
    return Math.sqrt(dx * dx + dy * dy);
};

const split = <T>(node: Node<T>): void => {
    const {minX, minY, maxX, maxY} = node.bounds;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const d = node.depth + 1;

    node.children = [
        {bounds: {minX, minY, maxX: midX, maxY: midY}, depth: d, points: [], children: null},
        {bounds: {minX: midX, minY, maxX, maxY: midY}, depth: d, points: [], children: null},
        {bounds: {minX, minY: midY, maxX: midX, maxY}, depth: d, points: [], children: null},
        {bounds: {minX: midX, minY: midY, maxX, maxY}, depth: d, points: [], children: null}
    ];

    for (const p of node.points) {
        for (const child of node.children) {
            if (inside(child.bounds, p.x, p.y)) {
                child.points.push(p);
                break;
            }
        }
    }

    node.points = [];
};

const insert = <T>(node: Node<T>, p: QuadtreePoint<T>): void => {
    if (!inside(node.bounds, p.x, p.y)) return;

    if (node.children === null) {
        node.points.push(p);
        if (node.points.length > MAX_POINTS_PER_NODE && node.depth < MAX_DEPTH) split(node);
        return;
    }

    for (const child of node.children) {
        if (inside(child.bounds, p.x, p.y)) {
            insert(child, p);
            return;
        }
    }
};

export class Quadtree<T> {
    private readonly root: Node<T>;

    public constructor(bounds: Bounds) {
        this.root = {bounds, depth: 0, points: [], children: null};
    }

    public add(p: QuadtreePoint<T>): void {
        insert(this.root, p);
    }

    public nearest(x: number, y: number, maxDistance: number): {point: QuadtreePoint<T>; distance: number} | null {
        let bestDist = maxDistance;
        let best: QuadtreePoint<T> | null = null;

        const stack: Node<T>[] = [this.root];

        while (stack.length > 0) {
            const node = stack.pop() as Node<T>;
            if (rectDist(node.bounds, x, y) > bestDist) continue;

            if (node.children === null) {
                for (const p of node.points) {
                    const dx = p.x - x;
                    const dy = p.y - y;
                    const d = Math.sqrt(dx * dx + dy * dy);
                    if (d < bestDist) {
                        bestDist = d;
                        best = p;
                    }
                }
                continue;
            }

            for (const child of node.children) stack.push(child);
        }

        return best === null ? null : {point: best, distance: bestDist};
    }
}