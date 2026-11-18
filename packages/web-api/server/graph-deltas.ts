import type {Graph, GraphEdge, GraphNode, Note} from '@synaipse/core';
import type {SynaipseService} from '@synaipse/service';
import {noteStamp, noteSummary, pruneSummaries, type NoteSummary} from './note-summary.js';

/**
 * Graph deltas over SSE (plan P4 / A5). Instead of every client
 * re-fetching `/api/notes` and `/api/graph` after each write, the server
 * diffs the previous and the current state once and broadcasts the
 * difference as a `graph-delta` event.
 *
 * Versioning: `from`/`to` are `service.graphVersion()` values. `/api/notes`
 * and `/api/graph` send the version they were built at in
 * {@link VERSION_HEADER}. A client applies a delta only if `from` equals
 * the version it holds; otherwise it re-fetches (missed events, reconnect,
 * or a fetch that raced a burst of writes).
 */
export const VERSION_HEADER = 'X-Synaipse-Version';

export const versionHeader = (service: SynaipseService): Record<string, string> => ({
    [VERSION_HEADER]: String(service.graphVersion())
});

export interface GraphDelta {
    from: number;
    to: number;
    nodes: {upsert: GraphNode[]; removed: string[]};
    edges: {added: GraphEdge[]; removed: GraphEdge[]};
    notes: {upsert: NoteSummary[]; removed: string[]};
}

/** Sent instead of a delta when no diff is possible or it would be too large. */
export interface GraphReset {
    to: number;
}

export interface DeltaSink {
    clientCount(): number;
    publishNamed(event: string, data: unknown): void;
}

interface Snapshot {
    version: number;
    nodes: Map<string, GraphNode>;
    edges: Map<string, GraphEdge>;
    /** id → stamp; the Note itself only to summarize upserts. */
    notes: Map<string, {stamp: string; note: Note}>;
}

const edgeKey = (e: GraphEdge): string => `${e.from}\u0000${e.to}\u0000${e.kind}`;

const sameNode = (a: GraphNode, b: GraphNode): boolean =>
    a.title === b.title && a.tags.length === b.tags.length && a.tags.every((t, i) => t === b.tags[i]);

const snapshotOf = (version: number, graph: Graph, notes: readonly Note[]): Snapshot => ({
    version,
    nodes: new Map(graph.nodes.map((n) => [n.id, n])),
    edges: new Map(graph.edges.map((e) => [edgeKey(e), e])),
    notes: new Map(notes.map((n) => [n.id, {stamp: noteStamp(n), note: n}]))
});

/** Difference between two snapshots. Pure; exported for tests. */
export const diffSnapshots = (service: SynaipseService, prev: Snapshot, next: Snapshot): GraphDelta => {
    const delta: GraphDelta = {
        from: prev.version,
        to: next.version,
        nodes: {upsert: [], removed: []},
        edges: {added: [], removed: []},
        notes: {upsert: [], removed: []}
    };

    for (const [id, node] of next.nodes) {
        const old = prev.nodes.get(id);
        if (old === undefined || !sameNode(old, node)) delta.nodes.upsert.push(node);
    }
    for (const id of prev.nodes.keys()) {
        if (!next.nodes.has(id)) delta.nodes.removed.push(id);
    }

    for (const [key, edge] of next.edges) {
        if (!prev.edges.has(key)) delta.edges.added.push(edge);
    }
    for (const [key, edge] of prev.edges) {
        if (!next.edges.has(key)) delta.edges.removed.push(edge);
    }

    for (const [id, entry] of next.notes) {
        if (prev.notes.get(id)?.stamp !== entry.stamp) delta.notes.upsert.push(noteSummary(service, entry.note));
    }
    for (const id of prev.notes.keys()) {
        if (!next.notes.has(id)) delta.notes.removed.push(id);
    }
    pruneSummaries(service, delta.notes.removed);

    return delta;
};

export const deltaSize = (d: GraphDelta): number =>
    d.nodes.upsert.length + d.nodes.removed.length
    + d.edges.added.length + d.edges.removed.length
    + d.notes.upsert.length + d.notes.removed.length;

export interface GraphDeltaOptions {
    /** Quiet time after the last change before a delta goes out. */
    debounceMs?: number;
    /** Upper bound on waiting during a continuous burst of writes. */
    maxWaitMs?: number;
    /** Above this many changed items a reset is cheaper than the delta. */
    maxChanges?: number;
}

/**
 * Watches the service and broadcasts deltas. Does no work while nobody
 * listens: without SSE clients the snapshot is dropped, and the first
 * change after a client connects is sent as a reset (re-fetch) because
 * there is nothing to diff against.
 */
export class GraphDeltaPublisher {
    private snapshot: Snapshot | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private firstPendingAt = 0;
    private readonly unsubscribe: () => void;
    private readonly debounceMs: number;
    private readonly maxWaitMs: number;
    private readonly maxChanges: number;

    public constructor(
        private readonly service: SynaipseService,
        private readonly sink: DeltaSink,
        opts: GraphDeltaOptions = {}
    ) {
        this.debounceMs = opts.debounceMs ?? 250;
        this.maxWaitMs = opts.maxWaitMs ?? 1000;
        this.maxChanges = opts.maxChanges ?? 5000;
        this.unsubscribe = service.onTopologyChange(() => this.schedule());
    }

    /** Take the baseline now (e.g. when the first client connects). */
    public prime(): void {
        if (this.snapshot === null) this.snapshot = this.capture();
    }

    public close(): void {
        this.unsubscribe();
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.snapshot = null;
    }

    /** Compute and publish now. Returns what was sent (for tests). */
    public flush(): {delta?: GraphDelta; reset?: GraphReset} | null {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.firstPendingAt = 0;

        if (this.sink.clientCount() === 0) {
            this.snapshot = null;
            return null;
        }

        const next = this.capture();
        const prev = this.snapshot;
        this.snapshot = next;

        if (prev === null) {
            const reset: GraphReset = {to: next.version};
            this.sink.publishNamed('graph-reset', reset);
            return {reset};
        }

        if (prev.version === next.version) return null;

        const delta = diffSnapshots(this.service, prev, next);

        if (deltaSize(delta) > this.maxChanges) {
            const reset: GraphReset = {to: next.version};
            this.sink.publishNamed('graph-reset', reset);
            return {reset};
        }

        this.sink.publishNamed('graph-delta', delta);
        return {delta};
    }

    private capture(): Snapshot {
        // graph() and listNotes() are synchronous, so the version read
        // here belongs to exactly this state.
        return snapshotOf(this.service.graphVersion(), this.service.graph(), this.service.listNotes());
    }

    private schedule(): void {
        if (this.sink.clientCount() === 0) {
            this.snapshot = null;
            return;
        }

        const now = Date.now();
        if (this.firstPendingAt === 0) this.firstPendingAt = now;
        if (this.timer !== null) clearTimeout(this.timer);

        const wait = Math.max(0, Math.min(this.debounceMs, this.firstPendingAt + this.maxWaitMs - now));
        this.timer = setTimeout(() => {
            this.flush();
        }, wait);
        this.timer.unref?.();
    }
}
