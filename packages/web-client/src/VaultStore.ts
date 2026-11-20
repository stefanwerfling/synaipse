import type {Graph} from '@synaipse/core';
import type {NoteSummary} from './Api.js';
import {applyGraphDelta, applyNotesDelta, isEmptyGraphDelta, type GraphDelta} from './GraphDelta.js';

/**
 * Client copy of the vault (plan P7 / D2): the note list and, once the
 * graph tab needed it, the graph, each with the server version it
 * reflects so SSE deltas can be applied in order (plan P4 / A5).
 */

export interface VaultSource {
    listNotes(): Promise<{data: NoteSummary[]; version: number | null}>;
    getGraph(): Promise<{data: Graph; version: number | null}>;
}

/** What applyDelta changed; `reload` means a version gap, so fetch everything again. */
export interface DeltaOutcome {
    notesChanged: boolean;
    graphChanged: boolean;
    reload: boolean;
}

export class VaultStore {
    public notes: NoteSummary[] = [];
    public graph: Graph | null = null;
    /** Active project from `/api/info`; null until known or when the vault has none. */
    public project: string | null = null;
    /** Server versions behind `notes` / `graph`; null = unknown, next delta re-fetches. */
    private notesVersion: number | null = null;
    private graphVersion: number | null = null;

    public constructor(private readonly source: VaultSource) {}

    /** Fetch the note list. Throws on failure; the old list stays. */
    public async loadNotes(): Promise<NoteSummary[]> {
        const {data, version} = await this.source.listNotes();
        this.notes = data;
        this.notesVersion = version;
        return data;
    }

    /** Fetch the graph. Throws on failure; the old graph stays. */
    public async loadGraph(): Promise<Graph> {
        const {data, version} = await this.source.getGraph();
        this.graph = data;
        this.graphVersion = version;
        return data;
    }

    /** Forget the graph; the graph tab fetches it again when it shows. */
    public dropGraph(): void {
        this.graph = null;
        this.graphVersion = null;
    }

    /**
     * Apply a server delta to the note list and, when loaded, the graph.
     * A version gap (missed events, a fetch that raced a write) asks for a
     * full reload instead; notes already applied stay applied.
     */
    public applyDelta(delta: GraphDelta): DeltaOutcome {
        const outcome: DeltaOutcome = {notesChanged: false, graphChanged: false, reload: false};

        if (this.notesVersion !== delta.from) {
            outcome.reload = true;
            return outcome;
        }

        this.notes = applyNotesDelta(this.notes, delta);
        this.notesVersion = delta.to;
        outcome.notesChanged = delta.notes.upsert.length > 0 || delta.notes.removed.length > 0;

        if (this.graph === null) return outcome;

        if (this.graphVersion !== delta.from) {
            outcome.reload = true;
            return outcome;
        }

        this.graphVersion = delta.to;
        if (isEmptyGraphDelta(delta)) return outcome;

        this.graph = applyGraphDelta(this.graph, delta);
        outcome.graphChanged = true;
        return outcome;
    }
}
