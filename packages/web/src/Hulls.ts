export type Point = readonly [number, number];

const cross = (o: Point, a: Point, b: Point): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

export const convexHull = (points: readonly Point[]): Point[] => {
    if (points.length <= 1) {
        return [...points];
    }

    const sorted = [...points].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

    const lower: Point[] = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
            lower.pop();
        }
        lower.push(p);
    }

    const upper: Point[] = [];
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
        const p = sorted[i]!;
        while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
            upper.pop();
        }
        upper.push(p);
    }

    lower.pop();
    upper.pop();

    return [...lower, ...upper];
};

export const centroid = (points: readonly Point[]): Point => {
    if (points.length === 0) {
        return [0, 0];
    }

    let sx = 0;
    let sy = 0;

    for (const [x, y] of points) {
        sx += x;
        sy += y;
    }

    return [sx / points.length, sy / points.length];
};

export const expandHull = (hull: readonly Point[], padding: number): Point[] => {
    if (hull.length < 3) {
        return [...hull];
    }

    const [cx, cy] = centroid(hull);

    return hull.map(([x, y]): Point => {
        const dx = x - cx;
        const dy = y - cy;
        const len = Math.hypot(dx, dy);

        if (len === 0) {
            return [x, y];
        }

        return [x + (dx / len) * padding, y + (dy / len) * padding];
    });
};

export const toSvgPoints = (points: readonly Point[]): string =>
    points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');