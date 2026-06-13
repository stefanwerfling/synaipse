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
    }

    public publish(event: SynaipseEvent): void {
        const payload = `data: ${JSON.stringify(event)}\n\n`;

        for (const client of this.clients) {
            try {
                client.write(payload);
            } catch {
                this.clients.delete(client);
            }
        }
    }

    public clientCount(): number {
        return this.clients.size;
    }
}