import type {IncomingMessage, ServerResponse} from 'node:http';
import type {Schedule, ScheduleInput, ScheduleStore} from '@synaipse/core';
import type {JobType} from './jobs.js';
import type {Scheduler} from './scheduler.js';
import {parseCron, nextFireTime} from './cron.js';

const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(body));
};

const notFound = (res: ServerResponse): void => json(res, 404, {error: 'not found'});
const methodNotAllowed = (res: ServerResponse): void => json(res, 405, {error: 'method not allowed'});
const badRequest = (res: ServerResponse, msg: string): void => json(res, 400, {error: msg});

const readJsonBody = async <T>(req: IncomingMessage): Promise<T> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw.length > 0 ? JSON.parse(raw) as T : ({} as T);
};

interface Result {
    handled: boolean;
}

const done: Result = {handled: true};
const skip: Result = {handled: false};

const ALLOWED_JOB_TYPES: readonly JobType[] = ['relink', 'compile', 'crawl-gitea'];

const validateCreateBody = (body: unknown): {ok: true; input: ScheduleInput} | {ok: false; message: string} => {
    if (typeof body !== 'object' || body === null) {
        return {ok: false, message: 'body must be an object'};
    }
    const b = body as Record<string, unknown>;

    if (typeof b.name !== 'string' || b.name.trim().length === 0) {
        return {ok: false, message: "field 'name' must be a non-empty string"};
    }
    if (typeof b.jobType !== 'string' || !ALLOWED_JOB_TYPES.includes(b.jobType as JobType)) {
        return {ok: false, message: `field 'jobType' must be one of ${ALLOWED_JOB_TYPES.join(', ')}`};
    }
    if (typeof b.cron !== 'string' || b.cron.trim().length === 0) {
        return {ok: false, message: "field 'cron' must be a non-empty string"};
    }
    if (typeof b.jobParams !== 'object' || b.jobParams === null) {
        return {ok: false, message: "field 'jobParams' must be an object"};
    }

    const cronResult = parseCron(b.cron);
    if (!cronResult.ok) {
        return {ok: false, message: cronResult.message};
    }

    return {
        ok: true,
        input: {
            name: b.name.trim(),
            jobType: b.jobType,
            jobParams: JSON.stringify(b.jobParams),
            cron: b.cron.trim(),
            ...(b.enabled === false ? {enabled: false} : {})
        }
    };
};

/**
 * Handle `/api/schedules` + `/api/schedules/:id[/run-now]`. Returns
 * `{handled: true}` when the request belonged to this surface (even
 * on validation errors) so the caller can `return` early.
 *
 * Endpoints:
 *   GET    /api/schedules              → list
 *   POST   /api/schedules              → create
 *   GET    /api/schedules/:id          → get one
 *   PUT    /api/schedules/:id          → patch (enabled/name/cron)
 *   DELETE /api/schedules/:id          → delete
 *   POST   /api/schedules/:id/run-now  → trigger immediately
 */
export const handleSchedulesRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    store: ScheduleStore,
    scheduler: Scheduler
): Promise<Result> => {
    const path = url.pathname;
    if (!path.startsWith('/api/schedules')) return skip;

    const method = req.method ?? 'GET';

    if (path === '/api/schedules') {
        if (method === 'GET') {
            const list = await store.list();
            json(res, 200, {schedules: list});
            return done;
        }

        if (method === 'POST') {
            const body = await readJsonBody<unknown>(req);
            const validation = validateCreateBody(body);
            if (!validation.ok) {
                badRequest(res, validation.message);
                return done;
            }

            const created = await store.create(validation.input);
            const cronResult = parseCron(created.cron);
            if (cronResult.ok) {
                const withNextRun = await store.update(created.id, {
                    nextRun: nextFireTime(cronResult.parsed, Date.now())
                });
                json(res, 201, {schedule: withNextRun ?? created});
            } else {
                // shouldn't happen — validated above — but be defensive
                json(res, 201, {schedule: created});
            }
            return done;
        }

        methodNotAllowed(res);
        return done;
    }

    // /api/schedules/:id[/run-now]
    const runNowMatch = /^\/api\/schedules\/([^/]+)\/run-now$/.exec(path);
    if (runNowMatch !== null) {
        if (method !== 'POST') { methodNotAllowed(res); return done; }
        const id = runNowMatch[1] as string;

        const current = await store.get(id);
        if (current === null) { notFound(res); return done; }

        // Force the schedule to fire on the next tick by rewinding nextRun
        // to now, then trigger a tick immediately.
        await store.update(id, {nextRun: Date.now()});
        void scheduler.tickOnce();

        const updated = await store.get(id) ?? current;
        json(res, 200, {schedule: updated});
        return done;
    }

    const idMatch = /^\/api\/schedules\/([^/]+)$/.exec(path);
    if (idMatch !== null) {
        const id = idMatch[1] as string;

        if (method === 'GET') {
            const s = await store.get(id);
            if (s === null) { notFound(res); return done; }
            json(res, 200, {schedule: s});
            return done;
        }

        if (method === 'PUT') {
            const current = await store.get(id);
            if (current === null) { notFound(res); return done; }

            const body = await readJsonBody<Record<string, unknown>>(req);
            const patch: Partial<Omit<Schedule, 'id' | 'createdAt'>> = {};

            if (typeof body.name === 'string' && body.name.trim().length > 0) {
                patch.name = body.name.trim();
            }
            if (typeof body.enabled === 'boolean') {
                patch.enabled = body.enabled;
            }
            if (typeof body.cron === 'string' && body.cron.trim().length > 0) {
                const cronResult = parseCron(body.cron);
                if (!cronResult.ok) { badRequest(res, cronResult.message); return done; }
                patch.cron = body.cron.trim();
                patch.nextRun = nextFireTime(cronResult.parsed, Date.now());
            }

            const updated = await store.update(id, patch);
            json(res, 200, {schedule: updated});
            return done;
        }

        if (method === 'DELETE') {
            const existed = await store.delete(id);
            if (!existed) { notFound(res); return done; }
            res.writeHead(204);
            res.end();
            return done;
        }

        methodNotAllowed(res);
        return done;
    }

    notFound(res);
    return done;
};