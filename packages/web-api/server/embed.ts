import path from 'node:path';
import type {IncomingMessage, RequestListener, ServerResponse} from 'node:http';
import type {URL} from 'node:url';
import type {AccountStore, Config, ScheduleStore, UserStore} from '@synaipse/core';
import type {ServiceOverrides} from '@synaipse/service';
import type {SynaipseService as SynaipseServiceType} from '@synaipse/service';
import type {AuthContext, PrincipalResolver} from './auth-routes.js';

export type {HostPrincipal, PrincipalResolver} from './auth-routes.js';
import type {SynaipseRegistrar} from '@synaipse/mcp-server';

const DEFAULT_AUTH_CACHE_TTL_MS = 60_000;

const resolveAuthCacheTtlMs = (env: NodeJS.ProcessEnv): number => {
    const raw = env.SYNAIPSE_AUTH_CACHE_TTL_MS;
    if (raw === undefined || raw.trim() === '') return DEFAULT_AUTH_CACHE_TTL_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_AUTH_CACHE_TTL_MS;
    return parsed;
};

const resolveSecureCookie = (env: NodeJS.ProcessEnv): boolean => {
    const raw = env.SYNAIPSE_COOKIE_SECURE;
    if (raw === undefined) return false;
    const lower = raw.trim().toLowerCase();
    return lower === '1' || lower === 'true' || lower === 'yes';
};

/**
 * Everything the embedding host (standalone `index.ts`, or an in-process
 * host like PKG Studio) needs to wire Synaipse into an HTTP surface:
 * two plain Node request handlers sharing one started `SynaipseService`.
 * The factory never calls `listen` and installs no signal handlers — the
 * caller owns the transport and lifecycle (see `close`).
 *
 * Import the types from `@synaipse/web/embed` instead of copying them.
 */
export interface SynaipseEmbed {
    /**
     * Handles `/api/*` (the full REST surface). `url.pathname` is matched.
     * Works whether or not the host already parsed the body (express.json()).
     */
    apiHandle: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;
    /** Handles the MCP Streamable-HTTP endpoint (stateful sessions). */
    mcpHandler: RequestListener;
    /** The MCP base path this embed answers on (e.g. "/mcp"). */
    mcpBasePath: string;
    /**
     * Registers the Synaipse tools on a host gateway's McpServer (plan P9 /
     * E2), e.g. PKG Studio's `mountMcp(app, '/mcp', [..., embed.mcpRegistrar])`.
     * Calls run with full rights in the configured project. In server mode
     * (accounts, per-token ACL) it registers nothing: there clients use
     * `mcpHandler` with their token.
     */
    mcpRegistrar: SynaipseRegistrar;
    mode: 'local' | 'server';
    /** The shared, already-started service (vault + vector + scheduler). */
    service: SynaipseServiceType;
    /**
     * Tears down everything this embed started: scheduler and schedule
     * store, running jobs, SSE clients, MCP sessions, the service (watcher,
     * state DB) and the storage adapters. Idempotent.
     */
    close: () => Promise<void>;
}

export type SynaipseHealth =
    | {status: 'starting'}
    | {status: 'ready'; notes: number; mode: 'local' | 'server'}
    | {status: 'failed'; error: string}
    | {status: 'closed'};

/**
 * Returned synchronously by {@link startSynaipseEmbed}: the handlers work
 * immediately and answer 503 + `Retry-After` until `ready` resolves — the
 * host needs no "is it up yet" heuristic of its own.
 */
export interface SynaipseEmbedHandle {
    ready: Promise<SynaipseEmbed>;
    health(): SynaipseHealth;
    apiHandle: SynaipseEmbed['apiHandle'];
    mcpHandler: RequestListener;
    mcpBasePath: string;
    /**
     * As {@link SynaipseEmbed.mcpRegistrar}. The gateway builds a server per
     * session; sessions opened before startup finished get no Synaipse tools.
     */
    mcpRegistrar: SynaipseRegistrar;
    close(): Promise<void>;
}

interface OverridesResult {
    overrides: ServiceOverrides;
    userStore: UserStore | null;
    accountStore: AccountStore | null;
    scheduleStore: ScheduleStore | null;
    close: () => Promise<void>;
}

export interface CreateSynaipseEmbedOptions {
    /** Override the MCP base path (default: SYNAIPSE_MCP_PATH or "/mcp"). */
    mcpBasePath?: string;
    /**
     * Explicit configuration. When omitted it is built from `env` — so a
     * host passes its settings here instead of mutating `process.env`.
     */
    config?: Config;
    /**
     * Environment for everything not in `config` (MCP path, cookie flag,
     * auth-cache TTL, crawler API keys). Default: `process.env`.
     */
    env?: NodeJS.ProcessEnv;
    /**
     * Server mode only: the host owns sign-in (PKG Studio G7). Called per
     * API request, it returns the signed-in host user's e-mail (or null);
     * Synaipse maps it to its account of that e-mail — accounts are still
     * created by a Synaipse admin. Synaipse's own login and session cookie
     * are off then. Ignored in local mode (no accounts). The MCP endpoint
     * keeps its bearer tokens either way.
     */
    principal?: PrincipalResolver;
}

/**
 * Builds a Synaipse service + its API/MCP handlers from the current
 * environment (`loadConfigFromEnv`). Mirrors the construction that
 * `index.ts#main` used to do inline, factored out so the standalone
 * server and any in-process host share one wiring path.
 */
export const createSynaipseEmbed = async (
    options: CreateSynaipseEmbedOptions = {}
): Promise<SynaipseEmbed> => {
    const {loadConfigFromEnv} = await import('@synaipse/core');
    const {SynaipseService, NoopAssetStore} = await import('@synaipse/service');
    const {CachedUserStore, buildMcpHttpHandler, createSynaipseRegistrar} = await import('@synaipse/mcp-server');
    const {NoopHistory, withServerHistory} = await import('@synaipse/vault');
    const {routes} = await import('./routes.js');
    const {EventBroadcaster} = await import('./events.js');
    const {GraphDeltaPublisher} = await import('./graph-deltas.js');
    const {JobManager} = await import('./jobs.js');
    const {MemoryJobStore, SqliteJobStore} = await import('./job-store.js');
    const {LocalScheduleStore} = await import('./local-schedule-store.js');
    const {Scheduler} = await import('./scheduler.js');
    const {InMemorySessionStore} = await import('./sessions.js');
    const {LoginRateLimit} = await import('./login-rate-limit.js');

    const env = options.env ?? process.env;
    const config = options.config ?? loadConfigFromEnv(env);
    const mcpBasePath = (options.mcpBasePath ?? env.SYNAIPSE_MCP_PATH ?? '/mcp')
        .replace(/\/+$/, '') || '/mcp';

    const buildOverrides = async (): Promise<OverridesResult> => {
        if (config.mode !== 'server') {
            return {
                overrides: {},
                userStore: null,
                accountStore: null,
                scheduleStore: null,
                close: () => Promise.resolve()
            };
        }

        if (config.mariadb === undefined) {
            throw new Error('config.mode=server requires config.mariadb — check loadConfigFromEnv');
        }

        const {createServerAdapters} = await import('@synaipse/server-storage');
        const bundle = await createServerAdapters(config.mariadb);
        const versioned = withServerHistory(
            bundle.notes,
            config.git?.autoCommit === false ? undefined : config.git?.serverDir,
            config.git?.author
        );

        const cacheTtl = resolveAuthCacheTtlMs(env);
        const userStore: UserStore = cacheTtl > 0
            ? new CachedUserStore(bundle.users, cacheTtl)
            : bundle.users;

        return {
            overrides: {
                notes: versioned.notes,
                chats: bundle.chats,
                history: versioned.history ?? new NoopHistory(),
                assetStore: new NoopAssetStore(),
                skipWatcher: true
            },
            userStore,
            accountStore: bundle.accounts,
            scheduleStore: bundle.schedules,
            close: () => bundle.close()
        };
    };

    const {overrides, userStore, accountStore, scheduleStore: mariaScheduleStore, close: closeAdapters} =
        await buildOverrides();

    let auth: AuthContext | null = null;
    if (config.mode === 'server' && accountStore !== null) {
        auth = {
            sessions: new InMemorySessionStore(),
            accounts: accountStore,
            rateLimit: new LoginRateLimit(),
            secureCookie: resolveSecureCookie(env),
            ...(options.principal !== undefined ? {principal: options.principal} : {})
        };
    } else if (options.principal !== undefined) {
        console.warn('[synaipse] principal option ignored: local mode has no accounts');
    }

    const service = new SynaipseService(config, overrides);
    await service.start();

    const broadcaster = new EventBroadcaster();
    const graphDeltas = new GraphDeltaPublisher(service, broadcaster);
    broadcaster.onConnect(() => graphDeltas.prime());
    // Job history in the vault's state.db (local mode); server mode keeps
    // it in memory until jobs move to MariaDB.
    const jobStore = config.mode === 'server'
        ? new MemoryJobStore()
        : new SqliteJobStore(config.statePath ?? path.join(config.vaultPath, '.synaipse', 'state.db'));
    const jobs = new JobManager(service, env, jobStore);

    const scheduleStore: ScheduleStore = mariaScheduleStore ?? new LocalScheduleStore(config.schedulesPath);
    const scheduler = new Scheduler(scheduleStore, jobs);
    scheduler.start();

    const apiHandle = routes(service, broadcaster, jobs, {
        mode: config.mode === 'server' ? 'server' : 'local',
        auth,
        userStore,
        config,
        scheduleStore,
        scheduler
    });

    service.onVaultChange((event) => {
        broadcaster.publish({
            tool: 'fs-watcher',
            kind: event.kind === 'deleted' ? 'delete' : 'write',
            touched: [event.noteId],
            ts: Date.now()
        });
    });

    const mcpHandler = buildMcpHttpHandler(config, service, {
        basePath: mcpBasePath,
        eventsUrl: null,
        userStore
    });

    const mode = config.mode === 'server' ? 'server' : 'local';
    const gatewayTools = mode === 'local' ? createSynaipseRegistrar(service) : null;
    let warned = false;
    const mcpRegistrar: SynaipseRegistrar = (server) => {
        if (gatewayTools === null) {
            if (!warned) console.warn('[synaipse] server mode: no tools on the host MCP gateway, use the Synaipse MCP endpoint with a token');
            warned = true;
            return;
        }
        gatewayTools(server);
    };

    let closed: Promise<void> | null = null;
    const close = (): Promise<void> => {
        closed ??= (async () => {
            scheduler.stop();
            graphDeltas.close();
            jobs.stopAll();
            broadcaster.close();
            await mcpHandler.closeAll();
            await scheduleStore.close();
            await service.stop();
            jobs.close();
            await closeAdapters();
        })();
        return closed;
    };

    return {apiHandle, mcpHandler, mcpBasePath, mcpRegistrar, mode, service, close};
};

/**
 * Start Synaipse in the background and hand back working handlers at once
 * (plan P3 / E2). Until startup finished they answer 503 with
 * `Retry-After`; after a failed start, 500 with the reason.
 */
export const startSynaipseEmbed = (options: CreateSynaipseEmbedOptions = {}): SynaipseEmbedHandle => {
    const mcpBasePath = (options.mcpBasePath ?? (options.env ?? process.env).SYNAIPSE_MCP_PATH ?? '/mcp')
        .replace(/\/+$/, '') || '/mcp';
    let state: SynaipseHealth = {status: 'starting'};
    let embed: SynaipseEmbed | null = null;

    const ready = createSynaipseEmbed({...options, mcpBasePath});
    ready.then(
        (e) => {
            embed = e;
            if (state.status === 'starting') {
                state = {status: 'ready', notes: e.service.listNotes().length, mode: e.mode};
            } else {
                // close() was called while starting: tear down right away.
                void e.close();
            }
        },
        (error: unknown) => {
            state = {status: 'failed', error: error instanceof Error ? error.message : String(error)};
        }
    );

    const notReady = (res: ServerResponse): void => {
        if (state.status === 'starting') {
            res.statusCode = 503;
            res.setHeader('Retry-After', '1');
            res.end('synaipse is starting');
            return;
        }
        res.statusCode = state.status === 'failed' ? 500 : 503;
        res.end(state.status === 'failed' ? `synaipse failed to start: ${state.error}` : 'synaipse is closed');
    };

    return {
        ready,
        mcpBasePath,
        health: () => {
            if (state.status === 'ready' && embed !== null) {
                return {...state, notes: embed.service.listNotes().length};
            }
            return state;
        },
        apiHandle: async (req, res, url) => {
            if (embed === null || state.status !== 'ready') {
                notReady(res);
                return;
            }
            await embed.apiHandle(req, res, url);
        },
        mcpHandler: (req, res) => {
            if (embed === null || state.status !== 'ready') {
                notReady(res);
                return;
            }
            embed.mcpHandler(req, res);
        },
        mcpRegistrar: (server) => {
            if (embed === null || state.status !== 'ready') {
                console.warn(`[synaipse] MCP gateway session while synaipse is ${state.status}: no synaipse tools in it`);
                return;
            }
            embed.mcpRegistrar(server);
        },
        close: async () => {
            const wasReady = state.status === 'ready';
            state = {status: 'closed'};
            if (wasReady && embed !== null) await embed.close();
        }
    };
};
