#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config as dotenvConfig} from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
process.chdir(repoRoot);
dotenvConfig();

const {loadConfigFromEnv} = await import('@synaipse/core');
const {startServer} = await import('./Server.js');

const config = loadConfigFromEnv();

const resolveEventsUrl = (): string | null => {
    const explicit = process.env.SYNAIPSE_EVENTS_URL;

    if (explicit !== undefined) {
        return explicit.trim() === '' ? null : explicit;
    }

    const port = process.env.WEB_API_PORT ?? '3001';
    return `http://localhost:${port}/api/events`;
};

const resolveTransport = (): 'stdio' | 'http' => {
    const raw = (process.env.SYNAIPSE_MCP_TRANSPORT ?? 'stdio').toLowerCase();
    return raw === 'http' ? 'http' : 'stdio';
};

const resolveHttpPort = (): number => {
    const raw = process.env.SYNAIPSE_MCP_PORT ?? '3030';
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 3030;
};

const resolveHttpPath = (): string => {
    const raw = process.env.SYNAIPSE_MCP_PATH ?? '/mcp';
    return raw.startsWith('/') ? raw : `/${raw}`;
};

startServer(config, {
    eventsUrl: resolveEventsUrl(),
    transport: resolveTransport(),
    httpPort: resolveHttpPort(),
    httpPath: resolveHttpPath()
}).catch((error: unknown) => {
    process.stderr.write(`[synaipse-mcp] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
});