import {EventEmitter} from 'node:events';

export type ConsentDecision = 'granted' | 'denied';
export type ConsentResult = ConsentDecision | 'timeout';

export interface ConsentRequest {
    id: string;
    noteId: string;
    /** Label of the MCP token that triggered the request (from TokenScope). */
    requester: string;
    createdAt: string;
    resolvedAt?: string;
    decision?: ConsentDecision;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Just-in-time consent broker for MCP note reads. When a tool handler
 * encounters a note whose `frontmatter.mcp_consent === "pending"`, it
 * calls `request()` here. The returned promise resolves when the UI
 * side approves/denies via {@link resolve}, or fires "timeout" after
 * the configured window (default 60s).
 *
 * Parallel MCP calls for the same noteId share one request record so
 * the UI only shows one prompt for N callers — the store dedupes by
 * noteId until the pending request is resolved.
 */
export class ConsentStore {
    private readonly emitter = new EventEmitter();
    private readonly requests = new Map<string, ConsentRequest>();
    /** noteId → id of the currently-open (unresolved) request for that note. */
    private readonly byNote = new Map<string, string>();
    private nextId = 1;

    public async request(
        noteId: string,
        requester: string,
        timeoutMs: number = DEFAULT_TIMEOUT_MS
    ): Promise<ConsentResult> {
        const existingId = this.byNote.get(noteId);
        const existing = existingId !== undefined ? this.requests.get(existingId) : undefined;
        const req = existing !== undefined && existing.decision === undefined
            ? existing
            : this.create(noteId, requester);

        return new Promise((resolve) => {
            let settled = false;

            const listener = (decision: ConsentDecision): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(decision);
            };

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                this.emitter.off(`resolved:${req.id}`, listener);
                resolve('timeout');
            }, timeoutMs);

            this.emitter.once(`resolved:${req.id}`, listener);
        });
    }

    private create(noteId: string, requester: string): ConsentRequest {
        const id = `consent-${this.nextId++}-${Date.now().toString(36)}`;
        const req: ConsentRequest = {
            id,
            noteId,
            requester,
            createdAt: new Date().toISOString()
        };
        this.requests.set(id, req);
        this.byNote.set(noteId, id);
        this.emitter.emit('new', req);
        return req;
    }

    /**
     * Called by the UI. Returns the updated record, or null when the
     * id is unknown or already resolved (idempotent double-click safety).
     */
    public resolve(id: string, decision: ConsentDecision): ConsentRequest | null {
        const req = this.requests.get(id);
        if (req === undefined) return null;
        if (req.decision !== undefined) return null;

        req.decision = decision;
        req.resolvedAt = new Date().toISOString();
        this.byNote.delete(req.noteId);

        this.emitter.emit(`resolved:${id}`, decision);
        this.emitter.emit('resolved', req);
        return req;
    }

    public pending(): ConsentRequest[] {
        return Array.from(this.requests.values())
            .filter((r) => r.decision === undefined);
    }

    public getById(id: string): ConsentRequest | undefined {
        return this.requests.get(id);
    }

    public onNew(cb: (req: ConsentRequest) => void): () => void {
        this.emitter.on('new', cb);
        return (): void => {
            this.emitter.off('new', cb);
        };
    }

    public onResolved(cb: (req: ConsentRequest) => void): () => void {
        this.emitter.on('resolved', cb);
        return (): void => {
            this.emitter.off('resolved', cb);
        };
    }
}