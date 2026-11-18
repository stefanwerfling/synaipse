import {apiUrl} from './ApiBase.js';
export type EventKind = 'read' | 'write' | 'delete' | 'search' | 'list' | 'graph' | 'tags';

export interface SynaipseEvent {
    tool: string;
    kind: EventKind;
    touched: string[];
    query?: string;
    ts: number;
}

export type EventListener = (event: SynaipseEvent) => void;

export class EventStream {
    private source: EventSource | null = null;
    private readonly listeners = new Set<EventListener>();
    private readonly named = new Map<string, Set<(data: unknown) => void>>();
    private readonly reconnectListeners = new Set<() => void>();
    private hadError = false;

    public start(url = apiUrl('/api/events/stream')): void {
        if (this.source !== null) {
            return;
        }

        this.source = new EventSource(url);

        this.source.onmessage = (msg) => {
            try {
                const data = JSON.parse(msg.data) as SynaipseEvent;
                for (const listener of this.listeners) {
                    listener(data);
                }
            } catch {
                // malformed payload — ignore
            }
        };

        for (const name of this.named.keys()) {
            this.attachNamed(name);
        }

        // EventSource reconnects on its own. Events sent while it was gone
        // are lost, so listeners re-sync once the stream is back.
        this.source.onerror = () => {
            this.hadError = true;
        };
        this.source.onopen = () => {
            if (!this.hadError) return;
            this.hadError = false;
            for (const listener of this.reconnectListeners) listener();
        };
    }

    public stop(): void {
        this.source?.close();
        this.source = null;
    }

    /** Named SSE events (`event: <name>`), e.g. `graph-delta`. Payload is the parsed JSON. */
    public subscribeNamed(name: string, listener: (data: unknown) => void): () => void {
        let set = this.named.get(name);
        if (set === undefined) {
            set = new Set();
            this.named.set(name, set);
            this.attachNamed(name);
        }
        set.add(listener);
        return () => {
            set.delete(listener);
        };
    }

    /** Called after the stream recovered from a drop (events may be missing). */
    public onReconnect(listener: () => void): () => void {
        this.reconnectListeners.add(listener);
        return () => {
            this.reconnectListeners.delete(listener);
        };
    }

    private attachNamed(name: string): void {
        this.source?.addEventListener(name, (msg) => {
            let data: unknown;
            try {
                data = JSON.parse((msg as MessageEvent<string>).data);
            } catch {
                return;
            }
            for (const listener of this.named.get(name) ?? []) {
                listener(data);
            }
        });
    }

    public subscribe(listener: EventListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
}