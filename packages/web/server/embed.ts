import type {IncomingMessage, RequestListener, ServerResponse} from 'node:http';
import type {URL} from 'node:url';
import type {AccountStore, ScheduleStore, UserStore} from '@synaipse/core';
import type {ServiceOverrides} from '@synaipse/service';
import type {SynaipseService as SynaipseServiceType} from '@synaipse/service';
import type {AuthContext} from './auth-routes.js';

const DEFAULT_AUTH_CACHE_TTL_MS = 60_000;

const resolveAuthCacheTtlMs = (): number => {
    const raw = process.env.SYNAIPSE_AUTH_CACHE_TTL_MS;
    if (raw === undefined || raw.trim() === '') return DEFAULT_AUTH_CACHE_TTL_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_AUTH_CACHE_TTL_MS;
    return parsed;
};

const resolveSecureCookie = (): boolean => {
    const raw = process.env.SYNAIPSE_COOKIE_SECURE;
    if (raw === undefined) return false;
    const lower = raw.trim().toLowerCase();
    return lower === '1' || lower === 'true' || lower === 'yes';
};

/**
 * Everything the embedding host (standalone `index.ts`, or an in-process
 * host like pkgstudio) needs to wire Synaipse into an HTTP surface:
 * two plain Node request handlers sharing one started `SynaipseService`.
 * The factory never calls `listen` and installs no signal handlers — the
 * caller owns the transport and lifecycle (see `close`).
 */
export interface SynaipseEmbed {
    /** Handles `/api/*` (the full REST surface). `url.pathname` is matched. */
    apiHandle: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;
    /** Handles the MCP Streamable-HTTP endpoint (stateful sessions). */
    mcpHandler: RequestListener;
    /** The MCP base path this embed answers on (e.g. "/mcp"). */
    mcpBasePath: string;
    /** The shared, already-started service (vault + vector + scheduler). */
    service: SynaipseServiceType;
    /** Tears down scheduler, schedule store, service and adapters. */
    close: () => Promise<void>;
}

interface OverridesResult {
    overrides: ServiceOverrides;
    userStore: UserStore | null;
    accountStore: AccountStore | null;
    scheduleStore: ScheduleStore | null;
    close: () => Promise<void>;
}

export interface CreateSynaipseEmbedOptions {
    /** Override the MCP base path (default: SYNAIPSE_MCP_PATH env or "/mcp"). */
    mcpBasePath?: string;
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
    const {CachedUserStore, buildMcpHttpHandler} = await import('@synaipse/mcp-server');
    const {NoopHistory} = await import('@synaipse/vault');
    const {routes} = await import('./routes.js');
    const {EventBroadcaster} = await import('./events.js');
    const {JobManager} = await import('./jobs.js');
    const {LocalScheduleStore} = await import('./local-schedule-store.js');
    const {Scheduler} = await import('./scheduler.js');
    const {InMemorySessionStore} = await import('./sessions.js');
    const {LoginRateLimit} = await import('./login-rate-limit.js');

    const config = loadConfigFromEnv();
    const mcpBasePath = (options.mcpBasePath ?? process.env.SYNAIPSE_MCP_PATH ?? '/mcp')
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

        const cacheTtl = resolveAuthCacheTtlMs();
        const userStore: UserStore = cacheTtl > 0
            ? new CachedUserStore(bundle.users, cacheTtl)
            : bundle.users;

        return {
            overrides: {
                notes: bundle.notes,
                chats: bundle.chats,
                history: new NoopHistory(),
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
            secureCookie: resolveSecureCookie()
        };
    }

    const service = new SynaipseService(config, overrides);
    await service.start();

    const broadcaster = new EventBroadcaster();
    const jobs = new JobManager(service);

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

    const close = async (): Promise<void> => {
        scheduler.stop();
        await scheduleStore.close();
        await service.stop();
        await closeAdapters();
    };

    return {apiHandle, mcpHandler, mcpBasePath, service, close};
};
