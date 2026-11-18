export type Position = {x: number; y: number};
export type PositionMap = Record<string, Position>;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const SPIRAL_SPACING = 32;

/**
 * Place all visible nodes deterministically without running a force layout.
 * - Nodes with a saved position use it verbatim.
 * - Nodes without one are placed at the centroid of their already-placed
 *   neighbours (with a small index-based jitter so coincident nodes don't
 *   pile up exactly on top of each other).
 * - Orphan new nodes are dropped on a golden-angle spiral around (0,0).
 *
 * A force layout over a multi-thousand-node vault blocked the main thread
 * for seconds; this is linear in nodes + edges.
 */
export const resolvePositions = (
    nodeIds: readonly string[],
    edges: ReadonlyArray<{source: string; target: string}>,
    savedPositions: Readonly<PositionMap>
): Map<string, Position> => {
    const out = new Map<string, Position>();
    const neighbours = new Map<string, string[]>();

    for (const id of nodeIds) {
        const saved = savedPositions[id];

        if (saved !== undefined) {
            out.set(id, {x: saved.x, y: saved.y});
        }
    }

    for (const e of edges) {
        const a = neighbours.get(e.source) ?? [];
        a.push(e.target);
        neighbours.set(e.source, a);
        const b = neighbours.get(e.target) ?? [];
        b.push(e.source);
        neighbours.set(e.target, b);
    }

    let orphanIndex = 0;

    for (const id of nodeIds) {
        if (out.has(id)) continue;

        let sumX = 0;
        let sumY = 0;
        let count = 0;

        for (const n of neighbours.get(id) ?? []) {
            if (n === id) continue;
            const pos = out.get(n);

            if (pos !== undefined) {
                sumX += pos.x;
                sumY += pos.y;
                count += 1;
            }
        }

        if (count > 0) {
            // Centroid of placed neighbours, plus a deterministic jitter on
            // a tiny golden-angle ring so multiple new siblings don't overlap.
            const jitterAngle = orphanIndex * GOLDEN_ANGLE;
            out.set(id, {
                x: sumX / count + Math.cos(jitterAngle) * 18,
                y: sumY / count + Math.sin(jitterAngle) * 18
            });
        } else {
            // No neighbour anchor — spiral around origin.
            const r = SPIRAL_SPACING * Math.sqrt(orphanIndex + 1);
            const theta = orphanIndex * GOLDEN_ANGLE;
            out.set(id, {x: r * Math.cos(theta), y: r * Math.sin(theta)});
        }

        orphanIndex += 1;
    }

    return out;
};
