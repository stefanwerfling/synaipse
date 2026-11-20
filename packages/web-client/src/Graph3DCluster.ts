import type {ForceGraph3DInstance} from '3d-force-graph';
import type {Vec3} from './Graph3DModel.js';

/**
 * Tag clustering for the 3D graph (plan P7 / D2): every tag gets a fixed
 * anchor on a sphere, and a custom d3 force pulls each node toward the
 * anchor of its first tag.
 */

const CLUSTER_ANCHOR_RADIUS = 220;
const CLUSTER_STRENGTH = 0.18;

interface SimNode {
    id: string;
    tags: string[];
    x?: number;
    y?: number;
    z?: number;
    vx: number;
    vy: number;
    vz: number;
}

/** Anchors for all tags, spread evenly over a sphere (golden-angle spiral, sorted tags). */
export const computeTagAnchors = (nodes: readonly {tags: readonly string[]}[]): Map<string, Vec3> => {
    const tagSet = new Set<string>();

    for (const node of nodes) {
        for (const tag of node.tags) {
            tagSet.add(tag);
        }
    }

    const sorted = [...tagSet].sort();
    const total = Math.max(1, sorted.length);
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const anchors = new Map<string, Vec3>();

    sorted.forEach((tag, i) => {
        const yNorm = total === 1 ? 0 : 1 - (i / (total - 1)) * 2;
        const r = Math.sqrt(Math.max(0, 1 - yNorm * yNorm));
        const theta = goldenAngle * i;

        anchors.set(tag, {
            x: CLUSTER_ANCHOR_RADIUS * Math.cos(theta) * r,
            y: CLUSTER_ANCHOR_RADIUS * yNorm,
            z: CLUSTER_ANCHOR_RADIUS * Math.sin(theta) * r
        });
    });

    return anchors;
};

type ClusterForceFn = ((alpha: number) => void) & {initialize: (nodes: SimNode[]) => void};

/** d3-style force: nudges each node's velocity toward its primary tag's anchor. */
export const makeClusterForce = (anchors: ReadonlyMap<string, Vec3>): ClusterForceFn => {
    let simNodes: SimNode[] = [];

    const force = ((alpha: number): void => {
        const strength = CLUSTER_STRENGTH * alpha;

        for (const node of simNodes) {
            const primaryTag = node.tags[0];

            if (primaryTag === undefined) {
                continue;
            }

            const anchor = anchors.get(primaryTag);

            if (anchor === undefined || node.x === undefined || node.y === undefined || node.z === undefined) {
                continue;
            }

            node.vx += (anchor.x - node.x) * strength;
            node.vy += (anchor.y - node.y) * strength;
            node.vz += (anchor.z - node.z) * strength;
        }
    }) as ClusterForceFn;

    force.initialize = (nodes: SimNode[]): void => {
        simNodes = nodes;
    };

    return force;
};

/** Attaches or detaches the `cluster` force on the graph's simulation. */
export class ClusterForce {
    private attached = false;

    public refresh(graph: ForceGraph3DInstance, enabled: boolean, nodes: readonly {tags: readonly string[]}[]): void {
        const forced = graph as unknown as {
            d3Force(name: string, force: unknown): unknown;
            d3ReheatSimulation(): unknown;
        };

        if (!enabled) {
            if (this.attached) {
                forced.d3Force('cluster', null);
                this.attached = false;
                forced.d3ReheatSimulation();
            }
            return;
        }

        forced.d3Force('cluster', makeClusterForce(computeTagAnchors(nodes)));
        this.attached = true;
        forced.d3ReheatSimulation();
    }
}
