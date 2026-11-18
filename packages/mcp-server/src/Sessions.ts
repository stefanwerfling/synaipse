/**
 * Open MCP HTTP sessions with idle expiry and a size cap (plan P8 / B5).
 * Clients that vanish without DELETE would otherwise keep their Server
 * and transport forever. An evicted client gets 404 on its next request
 * and, per the Streamable-HTTP spec, initializes a new session.
 */
export interface SessionLimits {
    /** Idle time after which a session is closed. */
    ttlMs: number;
    /** More open sessions than this: the longest idle one is closed. */
    max: number;
}

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX = 1000;

const positiveInt = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** `SYNAIPSE_MCP_SESSION_TTL_MS` (default 30 min), `SYNAIPSE_MCP_MAX_SESSIONS` (default 1000). */
export const resolveSessionLimits = (env: NodeJS.ProcessEnv = process.env): SessionLimits => ({
    ttlMs: positiveInt(env.SYNAIPSE_MCP_SESSION_TTL_MS, DEFAULT_TTL_MS),
    max: positiveInt(env.SYNAIPSE_MCP_MAX_SESSIONS, DEFAULT_MAX)
});

interface Slot<T> {
    value: T;
    lastSeen: number;
    /** Requests in flight; a busy session is never evicted. */
    busy: number;
}

export class SessionTable<T> {
    private readonly slots = new Map<string, Slot<T>>();

    public constructor(
        private readonly limits: SessionLimits,
        /** Called for each evicted session (close its server). */
        private readonly evict: (id: string, value: T) => void,
        private readonly now: () => number = Date.now
    ) {}

    public get size(): number {
        return this.slots.size;
    }

    public get(id: string): T | undefined {
        return this.slots.get(id)?.value;
    }

    public set(id: string, value: T): void {
        this.slots.set(id, {value, lastSeen: this.now(), busy: 0});
        this.enforceMax();
    }

    public delete(id: string): void {
        this.slots.delete(id);
    }

    public values(): T[] {
        return [...this.slots.values()].map((s) => s.value);
    }

    public clear(): void {
        this.slots.clear();
    }

    /** Run one request of a session; it counts as active until done. */
    public async use<R>(id: string, fn: () => Promise<R>): Promise<R> {
        const slot = this.slots.get(id);
        if (slot !== undefined) {
            slot.busy++;
            slot.lastSeen = this.now();
        }
        try {
            return await fn();
        } finally {
            if (slot !== undefined) {
                slot.busy--;
                slot.lastSeen = this.now();
            }
        }
    }

    /** Close sessions idle longer than the TTL; returns how many. */
    public sweep(): number {
        const cutoff = this.now() - this.limits.ttlMs;
        let evicted = 0;
        for (const [id, slot] of [...this.slots]) {
            if (slot.busy === 0 && slot.lastSeen < cutoff) {
                this.remove(id, slot);
                evicted++;
            }
        }
        return evicted;
    }

    private enforceMax(): void {
        while (this.slots.size > this.limits.max) {
            let oldest: [string, Slot<T>] | undefined;
            for (const entry of this.slots) {
                if (entry[1].busy === 0 && (oldest === undefined || entry[1].lastSeen < oldest[1].lastSeen)) oldest = entry;
            }
            if (oldest === undefined) return;
            this.remove(oldest[0], oldest[1]);
        }
    }

    private remove(id: string, slot: Slot<T>): void {
        this.slots.delete(id);
        this.evict(id, slot.value);
    }
}
