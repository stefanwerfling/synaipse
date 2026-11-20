import type {GraphInput} from './Layout.js';

/**
 * The layout input as it crosses to the worker (plan P4 / A4): each id once
 * as a string, edges as index pairs in a transferable Uint32Array. Sending
 * the graph objects instead clones every node's title, tags, path … and
 * two strings per edge into the worker heap, ~370 MB RSS at 50k notes.
 */
export interface PackedGraphInput {
    /** Node ids first (`nodeCount` of them), then edge endpoints that are no node. */
    names: string[];
    nodeCount: number;
    /** [from, to] index pairs into `names`. */
    pairs: Uint32Array;
    /** Per edge, only when any edge has a weight; NaN = none. */
    weights: Float64Array | null;
}

export const packGraphInput = (input: GraphInput): PackedGraphInput => {
    const names: string[] = [];
    const index = new Map<string, number>();
    const indexOf = (id: string): number => {
        let i = index.get(id);
        if (i === undefined) {
            i = names.length;
            names.push(id);
            index.set(id, i);
        }
        return i;
    };
    for (const node of input.nodes) indexOf(node.id);
    const nodeCount = names.length;

    const pairs = new Uint32Array(input.edges.length * 2);
    let weights: Float64Array | null = null;
    input.edges.forEach((edge, i) => {
        pairs[i * 2] = indexOf(edge.from);
        pairs[i * 2 + 1] = indexOf(edge.to);
        if (edge.weight !== undefined) {
            weights ??= new Float64Array(input.edges.length).fill(Number.NaN);
            weights[i] = edge.weight;
        }
    });

    return {names, nodeCount, pairs, weights};
};

export const unpackGraphInput = (packed: PackedGraphInput): GraphInput => {
    const {names, nodeCount, pairs, weights} = packed;
    const nodes = new Array<{id: string}>(nodeCount);
    for (let i = 0; i < nodeCount; i++) nodes[i] = {id: names[i]!};
    const edges = new Array<{from: string; to: string; weight?: number}>(pairs.length / 2);
    for (let i = 0; i < edges.length; i++) {
        const w = weights?.[i];
        edges[i] = w === undefined || Number.isNaN(w)
            ? {from: names[pairs[i * 2]!]!, to: names[pairs[i * 2 + 1]!]!}
            : {from: names[pairs[i * 2]!]!, to: names[pairs[i * 2 + 1]!]!, weight: w};
    }
    return {nodes, edges};
};

/** ArrayBuffers to move (not copy) with the packed input. */
export const transferablesOf = (packed: PackedGraphInput): ArrayBuffer[] => [
    packed.pairs.buffer as ArrayBuffer,
    ...(packed.weights !== null ? [packed.weights.buffer as ArrayBuffer] : [])
];
