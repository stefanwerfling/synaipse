import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config as dotenvConfig} from 'dotenv';
import http from 'node:http';
import {URL} from 'node:url';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import type {AccountStore, UserStore} from '@synaipse/core';
import {NoopAssetStore, type ServiceOverrides} from '@synaipse/service';
import {CachedUserStore} from '@synaipse/mcp-server';
import {InMemorySessionStore} from './sessions.js';
import {LoginRateLimit} from './login-rate-limit.js';
import type {AuthContext} from './auth-routes.js';

const DEFAULT_AUTH_CACHE_TTL_MS = 60_000;

const resolveAuthCacheTtlMs = (): number => {
    const raw = process.env.SYNAIPSE_AUTH_CACHE_TTL_MS;
    if (raw === undefined || raw.trim() === '') return DEFAULT_AUTH_CACHE_TTL_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_AUTH_CACHE_TTL_MS;
    return parsed;
};

const STATIC_MIME: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8'
};

/**
 * Serve a file from `staticDir` if the URL path resolves safely under it.
 * Falls back to `staticDir/index.html` for unknown paths so the SPA works
 * even when no client-side routing exists. Path-traversal is rejected by
 * comparing the resolved absolute path back against the staticDir prefix.
 *
 * Used in production / Docker. In dev, Vite serves the frontend on its
 * own port; this code never fires there (staticDir stays unset).
 */
const tryServeStatic = async (
    res: http.ServerResponse,
    pathname: string,
    staticDir: string
): Promise<boolean> => {
    const requested = pathname === '/' ? '/index.html' : pathname;
    const resolved = path.resolve(staticDir, '.' + requested);

    if (!resolved.startsWith(staticDir + path.sep) && resolved !== staticDir) {
        return false;
    }

    let target = resolved;

    try {
        const s = await stat(target);
        if (s.isDirectory()) {
            target = path.join(target, 'index.html');
            await stat(target);
        }
    } catch {
        // Unknown path → SPA-style fall back to index.html so deep links
        // don't 404 if a future client-side router lands.
        target = path.join(staticDir, 'index.html');
        try {
            await stat(target);
        } catch {
            return false;
        }
    }

    const mime = STATIC_MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {'Content-Type': mime});
    createReadStream(target).pipe(res);
    return true;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
process.chdir(repoRoot);
dotenvConfig();

const {loadConfigFromEnv} = await import('@synaipse/core');
const {SynaipseService} = await import('@synaipse/service');
const {buildMcpHttpHandler} = await import('@synaipse/mcp-server');
const {NoopHistory} = await import('@synaipse/vault');
const {routes} = await import('./routes.js');
const {EventBroadcaster} = await import('./events.js');
const {JobManager} = await import('./jobs.js');

const config = loadConfigFromEnv();

const MCP_BASE_PATH = (process.env.SYNAIPSE_MCP_PATH ?? '/mcp').replace(/\/+$/, '') || '/mcp';

interface OverridesResult {
    overrides: ServiceOverrides;
    userStore: UserStore | null;
    accountStore: AccountStore | null;
    close: () => Promise<void>;
}

const buildOverrides = async (): Promise<OverridesResult> => {
    if (config.mode !== 'server') {
        return {overrides: {}, userStore: null, accountStore: null, close: () => Promise.resolve()};
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
        close: () => bundle.close()
    };
};

const resolveSecureCookie = (): boolean => {
    const raw = process.env.SYNAIPSE_COOKIE_SECURE;
    if (raw === undefined) return false;
    const lower = raw.trim().toLowerCase();
    return lower === '1' || lower === 'true' || lower === 'yes';
};

const main = async (): Promise<void> => {
    const {overrides, userStore, accountStore, close: closeAdapters} = await buildOverrides();
    if (config.mode === 'server') {
        const cacheTtl = resolveAuthCacheTtlMs();
        const cacheNote = cacheTtl > 0 ? `auth-cache TTL=${cacheTtl}ms` : 'auth-cache OFF';
        process.stdout.write(`[synaipse-web-api] server-mode: MariaDB-backed adapters wired in (${cacheNote})\n`);
        if (config.server.tokens !== undefined && config.server.tokens.length > 0) {
            process.stdout.write(
                '[synaipse-web-api] WARN: config.server.tokens is set but mode=server — '
                + 'yaml tokens are ignored. Use `npm run user create` or `npm run user import-yaml` to populate the users table.\n'
            );
        }
    }

    let auth: AuthContext | null = null;
    if (config.mode === 'server' && accountStore !== null) {
        auth = {
            sessions: new InMemorySessionStore(),
            accounts: accountStore,
            rateLimit: new LoginRateLimit(),
            secureCookie: resolveSecureCookie()
        };
        process.stdout.write(
            `[synaipse-web-api] auth: cookie-session gate ON (Secure=${auth.secureCookie}). `
            + 'Bootstrap admin via `npm run admin bootstrap --email=... --password=...`\n'
        );
    }

    const service = new SynaipseService(config, overrides);
    await service.start();

    const broadcaster = new EventBroadcaster();
    const jobs = new JobManager(service);
    const handle = routes(service, broadcaster, jobs, {
        mode: config.mode === 'server' ? 'server' : 'local',
        auth,
        userStore
    });

    service.onVaultChange((event) => {
        broadcaster.publish({
            tool: 'fs-watcher',
            kind: event.kind === 'deleted' ? 'delete' : 'write',
            touched: [event.noteId],
            ts: Date.now()
        });
    });

    // Mount MCP under /mcp on the same http server, sharing the service.
    const mcpHandler = buildMcpHttpHandler(config, service, {
        basePath: MCP_BASE_PATH,
        eventsUrl: null,  // MCP would self-publish through the in-process broadcaster, but the existing publisher does http POST — skip the loopback round-trip and just rely on vault watcher events instead.
        userStore
    });

    const staticDirRaw = process.env.SYNAIPSE_STATIC_DIR;
    const staticDir = staticDirRaw !== undefined && staticDirRaw.length > 0
        ? path.resolve(staticDirRaw)
        : null;

    if (staticDir !== null) {
        process.stdout.write(`[synaipse-web-api] serving static frontend from ${staticDir}\n`);
    }

    const server = http.createServer((req, res) => {
        if (req.url !== undefined && req.url.startsWith(MCP_BASE_PATH)) {
            mcpHandler(req, res);
            return;
        }

        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

        if (url.pathname.startsWith('/api/')) {
            handle(req, res, url).catch((error: unknown) => {
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({error: error instanceof Error ? error.message : String(error)}));
            });
            return;
        }

        // Non-API, non-MCP GET requests fall through to the static frontend
        // when configured. Anything else (POST/PUT/DELETE on a non-API
        // path) goes through the routes handler so its 404/405 responses
        // stay consistent with API behaviour.
        if (staticDir !== null && (req.method === 'GET' || req.method === 'HEAD')) {
            void tryServeStatic(res, url.pathname, staticDir).then((served) => {
                if (!served) {
                    handle(req, res, url).catch((error: unknown) => {
                        res.writeHead(500, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({error: error instanceof Error ? error.message : String(error)}));
                    });
                }
            });
            return;
        }

        handle(req, res, url).catch((error: unknown) => {
            res.writeHead(500, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({error: error instanceof Error ? error.message : String(error)}));
        });
    });

    const apiPort = Number.parseInt(process.env.WEB_API_PORT ?? '3001', 10);

    server.listen(apiPort, () => {
        process.stdout.write(`[synaipse-web-api] listening on :${apiPort} (cwd=${process.cwd()})\n`);
        process.stdout.write(`[synaipse-web-api] MCP mounted at http://localhost:${apiPort}${MCP_BASE_PATH}\n`);
    });

    const shutdown = async (signal: string): Promise<void> => {
        process.stdout.write(`[synaipse-web-api] ${signal} — shutting down\n`);
        try {
            server.close();
            await service.stop();
            await closeAdapters();
        } finally {
            process.exit(0);
        }
    };

    process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.once('SIGINT', () => { void shutdown('SIGINT'); });
};

// undici's `TypeError: fetch failed` hides the real reason in `error.cause`
// (e.g. SocketError "other side closed", ECONNREFUSED). Walk the chain so
// the bootstrap log carries enough signal to act on.
const formatError = (error: unknown): string => {
    if (!(error instanceof Error)) {
        return String(error);
    }

    let out = error.stack ?? error.message;
    let cause: unknown = (error as Error & {cause?: unknown}).cause;

    while (cause !== undefined) {
        if (cause instanceof Error) {
            out += `\n  caused by: ${cause.stack ?? cause.message}`;
            cause = (cause as Error & {cause?: unknown}).cause;
        } else {
            out += `\n  caused by: ${String(cause)}`;
            cause = undefined;
        }
    }

    return out;
};

process.on('uncaughtException', (error: unknown) => {
    process.stderr.write(`[synaipse-web-api] uncaughtException: ${formatError(error)}\n`);
});

process.on('unhandledRejection', (reason: unknown) => {
    process.stderr.write(`[synaipse-web-api] unhandledRejection: ${formatError(reason)}\n`);
});

main().catch((error: unknown) => {
    process.stderr.write(`[synaipse-web-api] fatal: ${formatError(error)}\n`);
    process.exit(1);
});