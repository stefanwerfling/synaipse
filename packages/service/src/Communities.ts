/**
 * Louvain community detection — modularity-maximising clustering for the
 * note graph. No external deps. Uses the standard greedy two-phase algorithm:
 *
 *   1. Repeatedly move each node to the neighbour community that yields the
 *      highest modularity gain, until no node moves.
 *   2. Collapse each community into a super-node and repeat on the smaller
 *      graph, accumulating the partition until a single-level pass plateaus.
 *
 * The result is a flat `Map<nodeId, communityId>` where communityIds are
 * arbitrary integers — callers turn them into colours via a hash palette.
 */

export interface CommunityGraphNode {
    id: string;
}

export interface CommunityGraphEdge {
    from: string;
    to: string;
    weight?: number;
}

export interface CommunityResult {
    /** Map of original nodeId → community id (integer ≥ 0). */
    partition: Map<string, number>;
    /** Number of communities found. */
    count: number;
    /** Sizes per community (sorted descending). */
    sizes: number[];
    /** Final modularity score in [-1, 1]; higher = stronger structure. */
    modularity: number;
}

interface WeightedGraph {
    nodes: number[];
    /** Adjacency list: adj[node] → array of {neighbour, weight}. */
    adj: Map<number, Array<{n: number; w: number}>>;
    /** Sum of weights of edges incident to node (sum of own loops counts twice as in standard modularity). */
    k: Map<number, number>;
    /** Total edge weight (sum of all adj weights / 2 + self-loop weights). */
    m: number;
}

const buildWeightedGraph = (nodes: number[], edges: Array<{u: number; v: number; w: number}>): WeightedGraph => {
    const adj = new Map<number, Array<{n: number; w: number}>>();
    const k = new Map<number, number>();

    for (const n of nodes) {
        adj.set(n, []);
        k.set(n, 0);
    }

    let m = 0;

    for (const {u, v, w} of edges) {
        adj.get(u)?.push({n: v, w});
        k.set(u, (k.get(u) ?? 0) + w);

        if (u === v) {
            // self-loop contributes once on each side mathematically; we store
            // it once but k counts it twice as required by modularity.
            k.set(u, (k.get(u) ?? 0) + w);
            m += w;
        } else {
            adj.get(v)?.push({n: u, w});
            k.set(v, (k.get(v) ?? 0) + w);
            m += w;
        }
    }

    return {nodes, adj, k, m};
};

const runOnePass = (graph: WeightedGraph): {partition: Map<number, number>; improved: boolean} => {
    const community = new Map<number, number>();
    const sigmaTot = new Map<number, number>();

    for (const n of graph.nodes) {
        community.set(n, n);
        sigmaTot.set(n, graph.k.get(n) ?? 0);
    }

    let improved = false;
    let movedThisIter = true;
    let safety = 0;

    while (movedThisIter && safety < 32) {
        movedThisIter = false;
        safety += 1;

        for (const n of graph.nodes) {
            const ownComm = community.get(n) ?? n;
            const kn = graph.k.get(n) ?? 0;

            // Sum of weights from n to each neighbouring community (excluding self).
            const weightToComm = new Map<number, number>();

            for (const {n: nb, w} of graph.adj.get(n) ?? []) {
                if (nb === n) continue;
                const c = community.get(nb) ?? nb;
                weightToComm.set(c, (weightToComm.get(c) ?? 0) + w);
            }

            // Pull n out of its current community for the gain comparison.
            const stOwn = (sigmaTot.get(ownComm) ?? 0) - kn;
            const kIntoOwn = weightToComm.get(ownComm) ?? 0;

            // Gain of leaving and rejoining own community is 0 by construction.
            let bestComm = ownComm;
            let bestGain = 0;

            for (const [c, kIntoC] of weightToComm.entries()) {
                if (c === ownComm) continue;

                const stC = sigmaTot.get(c) ?? 0;
                // ΔQ = (k_i,C / m) − (Σ_tot(C) · k_i) / (2 m²)
                const gain = (kIntoC / graph.m) - (stC * kn) / (2 * graph.m * graph.m);

                if (gain > bestGain) {
                    bestGain = gain;
                    bestComm = c;
                }
            }

            if (bestComm !== ownComm) {
                sigmaTot.set(ownComm, stOwn);
                sigmaTot.set(bestComm, (sigmaTot.get(bestComm) ?? 0) + kn - 0);
                community.set(n, bestComm);
                movedThisIter = true;
                improved = true;
            } else {
                // No move — restore sigmaTot adjustments that we computed above
                // for the leave step are only applied on a successful move, so
                // there's nothing to undo here. We left kIntoOwn unused on
                // purpose: it's the within-community weight already captured.
                void kIntoOwn;
            }
        }
    }

    return {partition: community, improved};
};

const collapseGraph = (graph: WeightedGraph, partition: Map<number, number>): WeightedGraph => {
    const communities = new Set<number>();
    for (const c of partition.values()) communities.add(c);

    const superNodes = [...communities];
    const edgeWeights = new Map<string, number>();

    for (const n of graph.nodes) {
        const cu = partition.get(n) ?? n;

        for (const {n: nb, w} of graph.adj.get(n) ?? []) {
            const cv = partition.get(nb) ?? nb;
            const a = Math.min(cu, cv);
            const b = Math.max(cu, cv);
            const key = `${a}|${b}`;

            // adj is symmetric for non-self edges, so we'd double-count without
            // the min/max canonicalisation. Self-loops appear once and are
            // halved here to match the original weighted convention.
            if (a === b) {
                edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + w / 2);
            } else if (n < nb) {
                edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + w);
            }
        }
    }

    const edges: Array<{u: number; v: number; w: number}> = [];
    for (const [key, w] of edgeWeights.entries()) {
        const [a, b] = key.split('|').map(Number);
        edges.push({u: a as number, v: b as number, w});
    }

    return buildWeightedGraph(superNodes, edges);
};

const computeModularity = (graph: WeightedGraph, partition: Map<number, number>): number => {
    if (graph.m === 0) return 0;

    const sumIn = new Map<number, number>();
    const sumTot = new Map<number, number>();

    for (const n of graph.nodes) {
        const c = partition.get(n) ?? n;
        sumTot.set(c, (sumTot.get(c) ?? 0) + (graph.k.get(n) ?? 0));

        for (const {n: nb, w} of graph.adj.get(n) ?? []) {
            const cb = partition.get(nb) ?? nb;
            if (cb === c) {
                sumIn.set(c, (sumIn.get(c) ?? 0) + w);
            }
        }
    }

    let q = 0;
    for (const c of new Set(partition.values())) {
        const inC = (sumIn.get(c) ?? 0); // already counted both directions for non-self
        const tot = sumTot.get(c) ?? 0;
        q += (inC / (2 * graph.m)) - Math.pow(tot / (2 * graph.m), 2);
    }

    return q;
};

export const detectCommunities = (
    nodes: readonly CommunityGraphNode[],
    edges: readonly CommunityGraphEdge[]
): CommunityResult => {
    if (nodes.length === 0) {
        return {partition: new Map(), count: 0, sizes: [], modularity: 0};
    }

    // Map string ids to dense integers.
    const idToInt = new Map<string, number>();
    const intToId = new Map<number, string>();

    nodes.forEach((n, i) => {
        idToInt.set(n.id, i);
        intToId.set(i, n.id);
    });

    const intNodes = [...idToInt.values()];
    const intEdges: Array<{u: number; v: number; w: number}> = [];

    for (const e of edges) {
        const u = idToInt.get(e.from);
        const v = idToInt.get(e.to);
        if (u === undefined || v === undefined) continue;
        intEdges.push({u, v, w: e.weight ?? 1});
    }

    let graph = buildWeightedGraph(intNodes, intEdges);
    let currentPartition = new Map<number, number>();
    for (const n of intNodes) currentPartition.set(n, n);

    let safety = 0;

    while (safety < 10) {
        safety += 1;
        const {partition, improved} = runOnePass(graph);

        // Compose the new partition into the original-node partition.
        const composed = new Map<number, number>();
        for (const [origNode, oldComm] of currentPartition.entries()) {
            composed.set(origNode, partition.get(oldComm) ?? oldComm);
        }
        currentPartition = composed;

        if (!improved) break;

        graph = collapseGraph(graph, partition);
    }

    // Re-label communities to a dense [0..k-1] range, ordered by size descending.
    const sizeByLabel = new Map<number, number>();
    for (const c of currentPartition.values()) {
        sizeByLabel.set(c, (sizeByLabel.get(c) ?? 0) + 1);
    }

    const ordered = [...sizeByLabel.entries()].sort((a, b) => b[1] - a[1]);
    const remap = new Map<number, number>();
    ordered.forEach(([label], idx) => remap.set(label, idx));

    const finalPartition = new Map<string, number>();
    for (const [intId, comm] of currentPartition.entries()) {
        const id = intToId.get(intId);
        if (id === undefined) continue;
        finalPartition.set(id, remap.get(comm) ?? 0);
    }

    const modularity = computeModularity(graph, currentPartition);

    return {
        partition: finalPartition,
        count: ordered.length,
        sizes: ordered.map(([, n]) => n),
        modularity
    };
};