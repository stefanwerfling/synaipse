import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config as dotenvConfig} from 'dotenv';
import http from 'node:http';
import {URL} from 'node:url';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';

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

const main = async (): Promise<void> => {
    // All service/routes/MCP wiring now lives in the side-effect-free
    // embed factory so an in-process host (pkgstudio) can reuse it; here
    // we only add the HTTP transport, static serving and signal handling.
    const {createSynaipseEmbed} = await import('./embed.js');
    const embed = await createSynaipseEmbed();

    const {apiHandle, mcpHandler, mcpBasePath} = embed;

    if (process.env.SYNAIPSE_MODE === 'server') {
        process.stdout.write('[synaipse-web-api] server-mode active\n');
    }

    const staticDirRaw = process.env.SYNAIPSE_STATIC_DIR;
    const staticDir = staticDirRaw !== undefined && staticDirRaw.length > 0
        ? path.resolve(staticDirRaw)
        : null;

    if (staticDir !== null) {
        process.stdout.write(`[synaipse-web-api] serving static frontend from ${staticDir}\n`);
    }

    const server = http.createServer((req, res) => {
        if (req.url !== undefined && req.url.startsWith(mcpBasePath)) {
            mcpHandler(req, res);
            return;
        }

        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

        if (url.pathname.startsWith('/api/')) {
            apiHandle(req, res, url).catch((error: unknown) => {
                res.writeHead(500, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({error: error instanceof Error ? error.message : String(error)}));
            });
            return;
        }

        // Non-API, non-MCP GET requests fall through to the static frontend
        // when configured. Anything else goes through the API handler so its
        // 404/405 responses stay consistent.
        if (staticDir !== null && (req.method === 'GET' || req.method === 'HEAD')) {
            void tryServeStatic(res, url.pathname, staticDir).then((served) => {
                if (!served) {
                    apiHandle(req, res, url).catch((error: unknown) => {
                        res.writeHead(500, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({error: error instanceof Error ? error.message : String(error)}));
                    });
                }
            });
            return;
        }

        apiHandle(req, res, url).catch((error: unknown) => {
            res.writeHead(500, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({error: error instanceof Error ? error.message : String(error)}));
        });
    });

    const apiPort = Number.parseInt(process.env.WEB_API_PORT ?? '3001', 10);

    server.listen(apiPort, () => {
        process.stdout.write(`[synaipse-web-api] listening on :${apiPort} (cwd=${process.cwd()})\n`);
        process.stdout.write(`[synaipse-web-api] MCP mounted at http://localhost:${apiPort}${mcpBasePath}\n`);
    });

    const shutdown = async (signal: string): Promise<void> => {
        process.stdout.write(`[synaipse-web-api] ${signal} — shutting down\n`);
        try {
            server.close();
            await embed.close();
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
