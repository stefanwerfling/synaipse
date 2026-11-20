import type {IncomingMessage, ServerResponse} from 'node:http';
import type {Config, Frontmatter, ScheduleStore, UserStore} from '@synaipse/core';
import type {SynaipseService} from '@synaipse/service';
import type {AuthContext} from '../auth-routes.js';
import type {EventBroadcaster} from '../events.js';
import type {JobManager} from '../jobs.js';
import type {Scheduler} from '../scheduler.js';
import {readJsonObject} from '../body.js';
import {badRequest} from '../router.js';

export interface RoutesOptions {
    mode: 'local' | 'server';
    auth: AuthContext | null;
    /**
     * Lazy getter for the MCP-token UserStore (used by /api/tokens
     * self-service). Null in local-mode where there is no users table.
     */
    userStore?: UserStore | null;
    /**
     * Full config bundle — currently used by /api/clip to gate the
     * webclipper via `config.server.token(s)` bearer auth. Undefined in
     * tests that don't care about auth (route treats missing config as
     * "no auth configured" and lets requests through).
     */
    config?: Config;
    /**
     * Persistent store for /api/schedules CRUD. Optional so tests can
     * skip the scheduler surface; when both are undefined the routes
     * respond with 501 for any /api/schedules path.
     */
    scheduleStore?: ScheduleStore;
    scheduler?: Scheduler;
}

/** What every domain route module gets. */
export interface RouteDeps {
    service: SynaipseService;
    broadcaster: EventBroadcaster;
    jobs: JobManager;
    opts: RoutesOptions;
}

/** A JSON object body; anything else (null, array, scalar) is a 400, so handlers can read fields safely. */
export const readJson = <T extends object>(req: IncomingMessage): Promise<T> => readJsonObject<T>(req);

export const asString = (value: unknown, field: string): string => {
    if (typeof value !== 'string') {
        throw badRequest(`field '${field}' must be string`);
    }

    return value;
};

export const asFrontmatter = (value: unknown): Frontmatter | undefined => {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== 'object' || Array.isArray(value)) {
        throw badRequest("field 'frontmatter' must be object");
    }

    return value as Frontmatter;
};

export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Stream an async iterable as server-sent events; the iterable gets an
 * abort signal that fires when the client goes away. A failure becomes
 * a final `{kind: 'error'}` event instead of a broken stream.
 */
export const streamEvents = async (
    req: IncomingMessage,
    res: ServerResponse,
    produce: (signal: AbortSignal) => AsyncIterable<unknown>
): Promise<void> => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
    });

    const ctl = new AbortController();
    req.on('close', () => ctl.abort());

    try {
        for await (const event of produce(ctl.signal)) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
    } catch (error) {
        res.write(`data: ${JSON.stringify({kind: 'error', message: String(error)})}\n\n`);
    }

    res.end();
};
