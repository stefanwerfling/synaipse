import type * as THREE from 'three';
import {colorForNode} from './Colors.js';
import {PersistentValue} from './Persistence.js';

/**
 * Data model of the 3D graph (plan P7 / D2): node and link records, the
 * persisted position snapshot and the pure helpers the view builds on.
 * No three.js objects are created here.
 */

export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

export interface NodeRecord {
    id: string;
    title: string;
    tags: string[];
    color: string;
    radius: number;
    x?: number;
    y?: number;
    z?: number;
    sphere?: THREE.Mesh<THREE.SphereGeometry, THREE.MeshLambertMaterial>;
    baseColor?: THREE.Color;
    pulseUntil?: number;
    pulseColor?: THREE.Color;
    // Instance slot in the lean-mode InstancedMesh (== index in `nodes`).
    index?: number;
}

export interface LinkRecord {
    source: string;
    target: string;
}

/** A link endpoint before (id) or after (live node) 3d-force-graph mutated it. */
export type EndpointRef = string | NodeRecord;

export const FOCUS_DURATION_MS = 650;
export const FOCUS_DISTANCE = 90;
export const PULSE_DURATION_MS = 1400;

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** Activity heat 0..1 from the raw event count. */
export const heatLevel = (raw: number): number => Math.min(1, Math.max(0, raw / 5));

export const endpointId = (ref: EndpointRef): string => (typeof ref === 'string' ? ref : ref.id);

export const hasPosition = (node: {x?: number; y?: number; z?: number}): node is Vec3 =>
    node.x !== undefined && node.y !== undefined && node.z !== undefined;

const STORAGE_POSITIONS_3D = 'synaipse.graph3d.positions';
export type Position3DMap = Record<string, Vec3>;
// Debounce persistence: drag-end can fire rapidly during pan-drag, and a
// 3500-node vault is non-trivial to JSON.stringify.
const positionsStore3D = new PersistentValue<Position3DMap>(STORAGE_POSITIONS_3D, {}, undefined, 500);

export const loadSavedPositions = (): Position3DMap => positionsStore3D.get();

/**
 * Save current node positions to localStorage so the next mount can
 * skip the force-settling phase. Persistence is debounced inside
 * PersistentValue so rapid drag-end / engine-stop bursts collapse
 * to one JSON.stringify.
 */
export const savePositions = (nodes: readonly NodeRecord[]): void => {
    if (nodes.length === 0) {
        return;
    }

    const next: Position3DMap = {...positionsStore3D.get()};

    for (const node of nodes) {
        if (hasPosition(node)) {
            next[node.id] = {x: node.x, y: node.y, z: node.z};
        }
    }

    positionsStore3D.set(next);
};

/**
 * Fresh node records for a rebuild. A record keeps the rich-mode sphere
 * of its predecessor, and each coordinate follows the precedence
 * live in-memory > saved snapshot > left for the force engine to spawn.
 * Restoring across sessions means the user doesn't pay another 15s of
 * CPU-bound settling every time they re-enter the 3D tab.
 */
export const buildNodeRecords = (
    nodes: readonly {id: string; title: string; tags: string[]}[],
    previous: ReadonlyMap<string, NodeRecord>,
    saved: Position3DMap
): NodeRecord[] => nodes.map((n) => {
    const existing = previous.get(n.id);
    const record: NodeRecord = {
        id: n.id,
        title: n.title,
        tags: n.tags,
        color: colorForNode(n.tags),
        radius: 4 + Math.min(4, n.tags.length)
    };

    if (existing?.sphere !== undefined) {
        record.sphere = existing.sphere;

        if (existing.baseColor !== undefined) {
            record.baseColor = existing.baseColor;
        }
    }

    const snap = saved[n.id];

    for (const axis of ['x', 'y', 'z'] as const) {
        const value = existing?.[axis] ?? snap?.[axis];

        if (value !== undefined) {
            record[axis] = value;
        }
    }

    return record;
});

/** Undirected neighbour sets. */
export const buildAdjacency = (links: readonly LinkRecord[]): Map<string, Set<string>> => {
    const adjacency = new Map<string, Set<string>>();
    const add = (from: string, to: string): void => {
        let set = adjacency.get(from);

        if (set === undefined) {
            set = new Set<string>();
            adjacency.set(from, set);
        }

        set.add(to);
    };

    for (const link of links) {
        add(link.source, link.target);
        add(link.target, link.source);
    }

    return adjacency;
};

/** The hovered node plus its neighbours, or null when nothing is hovered. */
export const highlightSetFor = (
    hoverId: string | null,
    adjacency: ReadonlyMap<string, ReadonlySet<string>>
): Set<string> | null => {
    if (hoverId === null) {
        return null;
    }

    return new Set<string>([hoverId, ...(adjacency.get(hoverId) ?? [])]);
};

const LINK_COLOR_NORMAL = 'rgba(150, 160, 180, 0.45)';
const LINK_COLOR_HIGHLIGHT = 'rgba(255, 209, 102, 0.9)';
const LINK_COLOR_DIM = 'rgba(150, 160, 180, 0.08)';

/** Link colour while `hoverId` is hovered: its own links light up, the rest dim. */
export const linkColorForHover = (link: {source: EndpointRef; target: EndpointRef}, hoverId: string | null): string => {
    if (hoverId === null) {
        return LINK_COLOR_NORMAL;
    }

    return endpointId(link.source) === hoverId || endpointId(link.target) === hoverId
        ? LINK_COLOR_HIGHLIGHT
        : LINK_COLOR_DIM;
};
