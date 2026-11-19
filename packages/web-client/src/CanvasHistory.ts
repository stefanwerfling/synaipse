import type {CanvasDocument} from '@synaipse/core';

/**
 * Undo/redo for the canvas (plan P7 / D2). Every {@link record} pushes
 * the previous committed state onto the undo stack and clears the redo
 * stack. Undo and redo hand back a snapshot to show and persist without
 * recording it as a new action.
 *
 * Snapshots are structuredClone'd: a drag mutates node objects in
 * place, so a snapshot must never share references with the live doc.
 */
export class CanvasHistory {
    private undoStack: CanvasDocument[] = [];
    private redoStack: CanvasDocument[] = [];
    /** Mirror of the doc at the last commit: the clean pre-mutation snapshot for the next record. */
    private last: CanvasDocument;

    public constructor(doc: CanvasDocument, private readonly max = 50) {
        this.last = structuredClone(doc);
    }

    /** `doc` is the new committed state. */
    public record(doc: CanvasDocument): void {
        this.undoStack.push(this.last);
        if (this.undoStack.length > this.max) this.undoStack.shift();
        this.redoStack = [];
        this.last = structuredClone(doc);
    }

    /** The state before the last commit, or undefined when there is none. */
    public undo(): CanvasDocument | undefined {
        const prev = this.undoStack.pop();
        if (prev === undefined) return undefined;
        this.redoStack.push(this.last);
        this.last = structuredClone(prev);
        return prev;
    }

    public redo(): CanvasDocument | undefined {
        const next = this.redoStack.pop();
        if (next === undefined) return undefined;
        this.undoStack.push(this.last);
        this.last = structuredClone(next);
        return next;
    }
}
