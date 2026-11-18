import type {IncomingMessage, ServerResponse} from 'node:http';
import type {SynaipseService} from '@synaipse/service';
import type {EventBroadcaster} from './events.js';
import type {JobManager} from './jobs.js';
import {handleAuthRoute, resolveCurrentAccount} from './auth-routes.js';
import {handleTokensRoute} from './tokens-routes.js';
import {handleAdminRoute} from './admin-routes.js';
import {handleConsentRoute} from './consent-routes.js';
import {handleSchedulesRoute} from './schedules-routes.js';
import {HttpError, Router, json, withErrorMapping} from './router.js';
import {registerChatRoutes} from './routes/chat-routes.js';
import {registerGraphRoutes} from './routes/graph-routes.js';
import {registerInboxRoutes} from './routes/inbox-routes.js';
import {registerIngestRoutes} from './routes/ingest-routes.js';
import {registerMemoryRoutes} from './routes/memory-routes.js';
import {registerNotesRoutes} from './routes/notes-routes.js';
import {registerProjectRoutes} from './routes/project-routes.js';
import {registerSystemRoutes} from './routes/system-routes.js';
import type {RouteDeps, RoutesOptions} from './routes/shared.js';

export type {RoutesOptions} from './routes/shared.js';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

/**
 * Endpoints that bypass the requireAuth gate even in server-mode:
 *   - /api/auth/*          — the auth surface itself (chicken-and-egg)
 *   - /api/clip            — the browser-extension webclipper has its
 *                            own bearer auth pattern; locking it behind
 *                            cookie auth would break the extension
 *                            until clip-side login lands.
 */
const isPublicApiPath = (path: string): boolean => path === '/api/clip' || path.startsWith('/api/auth/');

/** The route table: one module per domain under `routes/`. */
export const buildRouter = (deps: RouteDeps): Router => {
    const router = new Router();

    registerSystemRoutes(router, deps);
    registerNotesRoutes(router, deps);
    registerGraphRoutes(router, deps);
    registerProjectRoutes(router, deps);
    registerChatRoutes(router, deps);
    registerMemoryRoutes(router, deps);
    registerIngestRoutes(router, deps);
    registerInboxRoutes(router, deps);

    return router;
};

/**
 * The `/api/*` handler (plan P4 / A5). Auth, tokens, admin, consent and
 * schedules keep their own modules with prefix dispatch; everything else
 * goes through the route table. Errors are mapped centrally.
 */
export const routes = (
    service: SynaipseService,
    broadcaster: EventBroadcaster,
    jobs: JobManager,
    opts: RoutesOptions = {mode: 'local', auth: null, userStore: null}
): Handler => {
    const router = buildRouter({service, broadcaster, jobs, opts});

    return withErrorMapping(async (req, res, url) => {
        const path = url.pathname;

        // Auth surface runs before the gate so login itself isn't gated.
        const authResult = await handleAuthRoute(req, res, url, opts.mode, opts.auth);
        if (authResult.handled) return;

        // Gate every other /api/* request in server-mode behind a valid
        // session. Local-mode is a no-op so dev / single-user / yaml-token
        // setups stay zero-config.
        if (opts.mode === 'server' && opts.auth !== null && path.startsWith('/api/') && !isPublicApiPath(path)) {
            const current = await resolveCurrentAccount(req, opts.auth);
            if (current === null) throw new HttpError(401, 'authentication required');
        }

        // Self-service token CRUD. Runs after the gate so the resolved
        // account is guaranteed valid by the time we look it up again.
        if (path.startsWith('/api/tokens') && opts.userStore !== null && opts.userStore !== undefined) {
            const userStore = opts.userStore;
            const result = await handleTokensRoute(req, res, url, opts.mode, opts.auth, async () => userStore);
            if (result.handled) return;
        }

        // Admin user-management. The handler re-resolves the current account
        // and refuses non-admins with 403 even if the gate let them through.
        if (path.startsWith('/api/admin/')) {
            const result = await handleAdminRoute(req, res, url, opts.mode, opts.auth);
            if (result.handled) return;
        }

        // Just-in-time consent inbox — SSE + approve/deny for MCP note-read gates.
        if (path.startsWith('/api/consent')) {
            const result = await handleConsentRoute(req, res, url, service);
            if (result.handled) return;
        }

        // Scheduled recurring jobs. Without runner + store (tests) the
        // surface answers 501 so callers see it exists but is off here.
        if (path.startsWith('/api/schedules')) {
            if (opts.scheduleStore === undefined || opts.scheduler === undefined) {
                throw new HttpError(501, 'schedules API is not enabled in this deployment');
            }
            const result = await handleSchedulesRoute(req, res, url, opts.scheduleStore, opts.scheduler);
            if (result.handled) return;
        }

        if (await router.dispatch(req, res, url)) return;

        json(res, 404, {error: 'not found'});
    });
};
