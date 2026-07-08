import type {IncomingMessage, ServerResponse} from 'node:http';
import type {ConsentDecision, ConsentRequest, SynaipseService} from '@synaipse/service';

const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(body));
};

const notFound = (res: ServerResponse): void => json(res, 404, {error: 'not found'});
const methodNotAllowed = (res: ServerResponse): void => json(res, 405, {error: 'method not allowed'});

interface Result {
    handled: boolean;
}

const done: Result = {handled: true};
const skip: Result = {handled: false};

/**
 * Handle `/api/consent/*`. Returns `{handled: true}` when the request
 * belonged to this surface (regardless of success/failure), so the
 * caller can `return` early. Returns `{handled: false}` when the path
 * is unrelated.
 *
 * Endpoints:
 *   GET  /api/consent/pending           → list of open ConsentRequest
 *   POST /api/consent/:id/approve       → resolve + write frontmatter
 *   POST /api/consent/:id/deny          → resolve + write frontmatter
 *   GET  /api/consent/stream            → SSE, emits `new` and `resolved`
 */
export const handleConsentRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    service: SynaipseService
): Promise<Result> => {
    const path = url.pathname;
    if (!path.startsWith('/api/consent')) return skip;

    const method = req.method ?? 'GET';
    const store = service.getConsentStore();

    if (path === '/api/consent/pending') {
        if (method !== 'GET') { methodNotAllowed(res); return done; }
        json(res, 200, {requests: store.pending()});
        return done;
    }

    if (path === '/api/consent/stream') {
        if (method !== 'GET') { methodNotAllowed(res); return done; }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.write(':\n\n');

        const send = (event: string, data: ConsentRequest): void => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        const offNew = store.onNew((r) => send('new', r));
        const offResolved = store.onResolved((r) => send('resolved', r));

        // Immediately replay the current pending set so a freshly-opened
        // stream doesn't need a separate GET /pending round-trip.
        for (const r of store.pending()) send('new', r);

        req.on('close', () => {
            offNew();
            offResolved();
        });

        return done;
    }

    // /api/consent/:id/approve|deny
    const decisionMatch = /^\/api\/consent\/([^/]+)\/(approve|deny)$/.exec(path);
    if (decisionMatch !== null) {
        if (method !== 'POST') { methodNotAllowed(res); return done; }

        const id = decisionMatch[1] ?? '';
        const decision = decisionMatch[2] as ConsentDecision;
        const req_ = await service.resolveConsent(id, decision);

        if (req_ === null) {
            json(res, 409, {error: 'unknown or already-resolved consent request', id});
            return done;
        }

        json(res, 200, {request: req_});
        return done;
    }

    notFound(res);
    return done;
};