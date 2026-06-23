import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config as dotenvConfig} from 'dotenv';
import http from 'node:http';
import {URL} from 'node:url';
import {NoopAssetStore, type ServiceOverrides} from '@synaipse/service';

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

const buildOverrides = async (): Promise<{overrides: ServiceOverrides; close: () => Promise<void>}> => {
    if (config.mode !== 'server') {
        return {overrides: {}, close: () => Promise.resolve()};
    }

    if (config.mariadb === undefined) {
        throw new Error('config.mode=server requires config.mariadb — check loadConfigFromEnv');
    }

    const {createServerAdapters} = await import('@synaipse/server-storage');
    const bundle = await createServerAdapters(config.mariadb);

    return {
        overrides: {
            notes: bundle.notes,
            chats: bundle.chats,
            history: new NoopHistory(),
            assetStore: new NoopAssetStore(),
            skipWatcher: true
        },
        close: () => bundle.close()
    };
};

const main = async (): Promise<void> => {
    const {overrides, close: closeAdapters} = await buildOverrides();
    if (config.mode === 'server') {
        process.stdout.write('[synaipse-web-api] server-mode: MariaDB-backed adapters wired in\n');
    }

    const service = new SynaipseService(config, overrides);
    await service.start();

    const broadcaster = new EventBroadcaster();
    const jobs = new JobManager(service);
    const handle = routes(service, broadcaster, jobs);

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
        eventsUrl: null  // MCP would self-publish through the in-process broadcaster, but the existing publisher does http POST — skip the loopback round-trip and just rely on vault watcher events instead.
    });

    const server = http.createServer((req, res) => {
        if (req.url !== undefined && req.url.startsWith(MCP_BASE_PATH)) {
            mcpHandler(req, res);
            return;
        }

        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

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