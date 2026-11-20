#!/usr/bin/env node
// Web server for the Playwright smoke (plan G3/P4): a copy of the fixture
// vault, the built standalone UI plus the mount() library and an embed host
// page as static files, isolated env (no repo .env, no embeddings, no git).
// Port: E2E_PORT (default 4177). Needs `npm run build` first.

import {spawn} from 'node:child_process';
import {cp, mkdir, mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isolatedEnv} from '../scripts/bench-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const port = Number(process.env.E2E_PORT ?? 4177);

const work = await mkdtemp(path.join(os.tmpdir(), 'synaipse-e2e-'));
const vault = path.join(work, 'vault');
const web = path.join(work, 'web');
const cwd = path.join(work, 'cwd');
await cp(path.join(here, 'fixture-vault'), vault, {recursive: true});
await cp(path.join(repoRoot, 'packages/web-client/dist/web'), web, {recursive: true});
await cp(path.join(repoRoot, 'packages/web-client/dist/lib'), path.join(web, 'lib'), {recursive: true});
await cp(path.join(here, 'embed-host.html'), path.join(web, 'embed-host.html'));
await mkdir(cwd, {recursive: true});

const child = spawn(process.execPath, [path.join(repoRoot, 'packages/web-api/dist/server/index.js')], {
    cwd,
    env: isolatedEnv(vault, port, {SYNAIPSE_STATIC_DIR: web}),
    stdio: 'inherit'
});

const cleanup = async () => {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    await rm(work, {recursive: true, force: true});
    process.exit(0);
};
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
child.once('exit', async (code) => {
    await rm(work, {recursive: true, force: true});
    process.exit(code ?? 1);
});
