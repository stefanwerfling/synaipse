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
const {routes} = await import('./routes.js');
const {EventBroadcaster} = await import('./events.js');

const config = loadConfigFromEnv();

const main = async (): Promise<void> => {
    const service = new SynaipseService(config);
    await service.start();

    const broadcaster = new EventBroadcaster();
    const handle = routes(service, broadcaster);

    service.onVaultChange((event) => {
        broadcaster.publish({
            tool: 'fs-watcher',
            kind: event.kind === 'deleted' ? 'delete' : 'write',
            touched: [event.noteId],
            ts: Date.now()
        });
    });

    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

        handle(req, res, url).catch((error: unknown) => {
            res.writeHead(500, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({error: error instanceof Error ? error.message : String(error)}));
        });
    });

    const apiPort = Number.parseInt(process.env.WEB_API_PORT ?? '3001', 10);

    server.listen(apiPort, () => {
        process.stdout.write(`[synaipse-web-api] listening on :${apiPort} (cwd=${process.cwd()})\n`);
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