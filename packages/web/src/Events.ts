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

    public start(url = '/api/events/stream'): void {
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

        this.source.onerror = () => {
            // EventSource auto-reconnects with exponential backoff; nothing to do
        };
    }

    public stop(): void {
        this.source?.close();
        this.source = null;
    }

    public subscribe(listener: EventListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
}