export type EventKind = 'read' | 'write' | 'delete' | 'search' | 'list' | 'graph' | 'tags';

export interface SynaipseEvent {
    tool: string;
    kind: EventKind;
    touched: string[];
    query?: string;
    ts: number;
}

export class EventPublisher {
    public constructor(private readonly url: string | null) {}

    public publish(event: SynaipseEvent): void {
        if (this.url === null) {
            return;
        }

        void fetch(this.url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(event),
            signal: AbortSignal.timeout(2000)
        }).catch(() => {
            // fire-and-forget — never block a tool call because the UI is offline
        });
    }
}