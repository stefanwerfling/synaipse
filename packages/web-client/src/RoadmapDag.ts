import type {RoadmapStatus, RoadmapStep} from '@synaipse/core';

/**
 * Pure model of the roadmap dependency graph (plan P10 / S4). The step tree
 * is cut at the collapsed phases: a step is a node when all its ancestors
 * are open and it is a leaf or itself closed (then it stands for its whole
 * subtree). Open phases become hulls around their visible steps.
 * `dependsOn` edges are remapped onto these nodes; the column of a node is
 * its longest dependency chain, so the graph reads left to right.
 */

export interface DagNode {
    id: string;
    title: string;
    status: RoadmapStatus;
    progress: number;
    /** Has children (open or closed). */
    isPhase: boolean;
    /** Closed phase: number of steps it hides. */
    hidden: number;
    /** Longest dependency chain leading here (0 = no visible dependency). */
    column: number;
}

export interface DagEdge {
    /** The dependency. */
    source: string;
    /** The step that waits for it. */
    target: string;
    /** How many step-level dependencies this edge stands for. */
    count: number;
}

export interface DagHull {
    /** The open phase. */
    id: string;
    title: string;
    nodeIds: string[];
}

export interface RoadmapDag {
    nodes: DagNode[];
    edges: DagEdge[];
    hulls: DagHull[];
}

const countSteps = (steps: readonly RoadmapStep[]): number =>
    steps.reduce((sum, s) => sum + 1 + countSteps(s.children ?? []), 0);

/**
 * @param steps the step tree, already without deleted steps
 * @param open  phases shown open; every other phase is closed
 */
export const buildRoadmapDag = (steps: readonly RoadmapStep[], open: ReadonlySet<string>): RoadmapDag => {
    const nodes = new Map<string, DagNode>();
    const hulls: DagHull[] = [];
    // Every step id → the node ids that represent it as a dependency (exits) and as a dependent (entries).
    const repOf = new Map<string, string[]>();
    const all = new Map<string, RoadmapStep>();
    const subtreeNodes = new Map<string, string[]>();

    const visit = (step: RoadmapStep, closedAncestor: string | null): string[] => {
        all.set(step.id, step);
        const kids = step.children ?? [];
        if (closedAncestor !== null) {
            repOf.set(step.id, [closedAncestor]);
            for (const kid of kids) visit(kid, closedAncestor);
            return [];
        }
        if (kids.length > 0 && open.has(step.id)) {
            const inner = kids.flatMap((kid) => visit(kid, null));
            subtreeNodes.set(step.id, inner);
            hulls.push({id: step.id, title: step.title, nodeIds: inner});
            return inner;
        }
        nodes.set(step.id, {
            id: step.id,
            title: step.title,
            status: step.status,
            progress: step.progress ?? (step.status === 'done' ? 100 : 0),
            isPhase: kids.length > 0,
            hidden: countSteps(kids),
            column: 0
        });
        repOf.set(step.id, [step.id]);
        for (const kid of kids) visit(kid, step.id);
        return [step.id];
    };
    for (const step of steps) visit(step, null);

    // Raw edges between visible nodes, before resolving open phases.
    const raw: Array<[string, string]> = [];
    for (const step of all.values()) {
        for (const dep of step.dependsOn ?? []) {
            if (all.has(dep)) raw.push([dep, step.id]);
        }
    }

    // An open phase as an endpoint: inside it, the steps nothing else in the
    // phase depends on are its exits, the steps that depend on nothing in the
    // phase are its entries. Computed on node level after mapping the rest.
    const nodeEdgesWithin = (members: ReadonlySet<string>): Array<[string, string]> => {
        const out: Array<[string, string]> = [];
        for (const [from, to] of raw) {
            const a = repOf.get(from) ?? [];
            const b = repOf.get(to) ?? [];
            for (const x of a) for (const y of b) {
                if (x !== y && members.has(x) && members.has(y)) out.push([x, y]);
            }
        }
        return out;
    };
    const exitsAndEntries = new Map<string, {exits: string[]; entries: string[]}>();
    for (const [phase, members] of subtreeNodes) {
        const set = new Set(members);
        const inside = nodeEdgesWithin(set);
        const hasOut = new Set(inside.map(([x]) => x));
        const hasIn = new Set(inside.map(([, y]) => y));
        const exits = members.filter((m) => !hasOut.has(m));
        const entries = members.filter((m) => !hasIn.has(m));
        exitsAndEntries.set(phase, {exits: exits.length > 0 ? exits : members, entries: entries.length > 0 ? entries : members});
    }
    const asSource = (id: string): string[] => exitsAndEntries.get(id)?.exits ?? repOf.get(id) ?? [];
    const asTarget = (id: string): string[] => exitsAndEntries.get(id)?.entries ?? repOf.get(id) ?? [];

    const edgeMap = new Map<string, DagEdge>();
    for (const [from, to] of raw) {
        for (const source of asSource(from)) {
            for (const target of asTarget(to)) {
                if (source === target) continue;
                const key = `${source}\u0000${target}`;
                const edge = edgeMap.get(key);
                if (edge === undefined) edgeMap.set(key, {source, target, count: 1});
                else edge.count += 1;
            }
        }
    }
    const edges = [...edgeMap.values()];

    // Longest path from the sources; edges that close a cycle are ignored.
    const outgoing = new Map<string, string[]>();
    for (const e of edges) outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e.target]);
    const indegree = new Map<string, number>([...nodes.keys()].map((id) => [id, 0]));
    for (const e of edges) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
    const queue = [...nodes.keys()].filter((id) => indegree.get(id) === 0);
    const placed = new Set<string>();
    while (queue.length > 0) {
        const id = queue.shift()!;
        placed.add(id);
        const column = nodes.get(id)!.column;
        for (const next of outgoing.get(id) ?? []) {
            const node = nodes.get(next)!;
            node.column = Math.max(node.column, column + 1);
            const left = indegree.get(next)! - 1;
            indegree.set(next, left);
            if (left === 0) queue.push(next);
        }
    }
    // Nodes on a cycle: one column after their furthest placed dependency.
    for (const node of nodes.values()) {
        if (placed.has(node.id)) continue;
        const deps = edges.filter((e) => e.target === node.id && placed.has(e.source));
        node.column = deps.reduce((max, e) => Math.max(max, nodes.get(e.source)!.column + 1), 0);
    }

    return {nodes: [...nodes.values()], edges, hulls};
};

/** Every phase id of the tree (steps with children). */
export const phaseIds = (steps: readonly RoadmapStep[]): string[] =>
    steps.flatMap((s) => ((s.children ?? []).length > 0 ? [s.id, ...phaseIds(s.children ?? [])] : []));
