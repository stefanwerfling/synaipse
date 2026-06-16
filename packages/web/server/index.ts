import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config as dotenvConfig} from 'dotenv';
import http from 'node:http';
import {URL} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
process.chdir(repoRoot);
dotenvConfig();

const {loadConfigFromEnv} = await import('@synaipse/core');
const {SynaipseService} = await import('@synaipse/service');
const {buildMcpHttpHandler} = await import('@synaipse/mcp-server');
const {routes} = await import('./routes.js');
const {EventBroadcaster} = await import('./events.js');
const {JobManager} = await import('./jobs.js');

const config = loadConfigFromEnv();

const MCP_BASE_PATH = (process.env.SYNAIPSE_MCP_PATH ?? '/mcp').replace(/\/+$/, '') || '/mcp';

const main = async (): Promise<void> => {
    const service = new SynaipseService(config);
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
};

process.on('uncaughtException', (error: Error) => {
    process.stderr.write(`[synaipse-web-api] uncaughtException: ${error.stack ?? error.message}\n`);
});

process.on('unhandledRejection', (reason: unknown) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`[synaipse-web-api] unhandledRejection: ${detail}\n`);
});

main().catch((error: unknown) => {
    process.stderr.write(`[synaipse-web-api] fatal: ${String(error)}\n`);
    process.exit(1);
});