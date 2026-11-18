import type {ServerResponse} from 'node:http';

export type EventKind = 'read' | 'write' | 'delete' | 'search' | 'list' | 'graph' | 'tags';

export interface SynaipseEvent {
    tool: string;
    kind: EventKind;
    touched: string[];
    query?: string;
    ts: number;
}

const KEEPALIVE_MS = 25_000;

export class EventBroadcaster {
    private readonly clients = new Set<ServerResponse>();
    private readonly connectListeners = new Set<() => void>();

    /** Runs after a client joined (e.g. to take a delta baseline). */
    public onConnect(listener: () => void): () => void {
        this.connectListeners.add(listener);
        return () => {
            this.connectListeners.delete(listener);
        };
    }

    public addClient(res: ServerResponse): void {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.write(':connected\n\n');

        const interval = setInterval(() => {
            try {
                res.write(':ping\n\n');
            } catch {
                // connection died; cleanup runs in 'close' handler
            }
        }, KEEPALIVE_MS);

        this.clients.add(res);

        const cleanup = (): void => {
            clearInterval(interval);
            this.clients.delete(res);
        };

        res.on('close', cleanup);
        res.on('error', cleanup);

        for (const listener of this.connectListeners) {
            listener();
        }
    }

    public publish(event: SynaipseEvent): void {
        this.send(`data: ${JSON.stringify(event)}\n\n`);
    }

    /**
     * A named SSE event (`event: <name>`). Browsers deliver it only to
     * `addEventListener(name)`, so `onmessage` consumers of the activity
     * feed never see it.
     */
    public publishNamed(name: string, data: unknown): void {
        this.send(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    private send(payload: string): void {
        for (const client of this.clients) {
            try {
                client.write(payload);
            } catch {
                this.clients.delete(client);
            }
        }
    }

    /** End every SSE stream (embed close): clients reconnect elsewhere or stop. */
    public close(): void {
        for (const client of this.clients) {
            try {
                client.end();
            } catch {
                // already gone
            }
        }
        this.clients.clear();
    }

    public clientCount(): number {
        return this.clients.size;
    }
}