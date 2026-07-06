#!/usr/bin/env node
// Boot the web server against a synthetic vault and measure:
//   - boot-to-listening time
//   - server-process RSS after boot
//   - /api/notes response time + payload size
//   - /api/graph/layout response time + payload size
//   - /api/search timing for a few queries
//
// Usage:
//   node scripts/bench-scale.mjs --vault=/tmp/vault-5k [--port=3801]
//
// Assumes the web package is already built (packages/web/dist/server).
// Doesn't touch the user's real vault or .env — cwd is set to a temp dir
// so dotenv can't pick up the repo-root .env, and every relevant SYNAIPSE_*
// var is passed explicitly.

import {spawn} from 'node:child_process';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v ?? true];
    })
);

const VAULT = path.resolve(args.vault ?? '/tmp/synaipse-bench-vault-5000');
const REQUESTED_PORT = args.port !== undefined ? Number(args.port) : null;

const findFreePort = () => new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        srv.close(() => resolve(port));
    });
});

const readRssBytes = async (pid) => {
    try {
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        const line = status.split('\n').find((l) => l.startsWith('VmRSS:'));
        if (line === undefined) return null;
        const match = line.match(/(\d+)/);
        return match !== null ? Number(match[1]) * 1024 : null;
    } catch {
        return null;
    }
};

const waitForNeedle = (stream, needle, timeoutMs) => new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
        stream.off('data', onData);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for "${needle}" — captured:\n${buf.slice(-2000)}`));
    }, timeoutMs);
    const onData = (chunk) => {
        buf += chunk.toString();
        if (buf.includes(needle)) {
            clearTimeout(timer);
            stream.off('data', onData);
            resolve(buf);
        }
    };
    stream.on('data', onData);
});

const timedFetch = async (url) => {
    const t0 = performance.now();
    const res = await fetch(url);
    const headerMs = performance.now() - t0;
    const bytes = Number(res.headers.get('content-length') ?? '0') || null;
    const body = await res.text();
    const totalMs = performance.now() - t0;
    return {
        status: res.status,
        headerMs: Math.round(headerMs),
        totalMs: Math.round(totalMs),
        bytes: bytes ?? Buffer.byteLength(body, 'utf8')
    };
};

const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
};

const main = async () => {
    const port = REQUESTED_PORT ?? (await findFreePort());
    const cwd = await mkdtemp(path.join(tmpdir(), 'synaipse-bench-'));

    const entry = path.join(repoRoot, 'packages/web/dist/server/index.js');
    console.log(`vault:     ${VAULT}`);
    console.log(`port:      ${port}`);
    console.log(`cwd:       ${cwd}`);
    console.log(`entry:     ${entry}`);
    console.log('');

    const env = {
        ...process.env,
        SYNAIPSE_MODE: 'local',
        SYNAIPSE_VAULT_PATH: VAULT,
        EMBEDDINGS_PROVIDER: 'none',
        SYNAIPSE_GIT_AUTOCOMMIT: 'false',
        WEB_API_PORT: String(port),
        // Kein Static-Frontend serven — API-only für den Bench.
        SYNAIPSE_STATIC_DIR: '',
        // MCP-Token nicht setzen; local-mode braucht keinen.
        // Kein Chat/Research konfigurieren — bleibt beim default "disabled".
        NODE_OPTIONS: '--enable-source-maps'
    };
    delete env.SYNAIPSE_MCP_TOKEN;

    const bootStart = performance.now();
    const server = spawn('node', [entry], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderrBuf = '';
    server.stderr.on('data', (c) => {
        stderrBuf += c.toString();
    });

    // The listening banner is printed via stdout.write in server/index.ts:255-257.
    try {
        await waitForNeedle(server.stdout, 'listening on', 240_000);
    } catch (err) {
        console.error('server never became ready. stderr tail:');
        console.error(stderrBuf.slice(-4000));
        server.kill('SIGKILL');
        process.exit(1);
    }
    const bootMs = Math.round(performance.now() - bootStart);

    // Give the server a beat to finish any post-listen background work
    // (last-mile index warmup, etc.) and let RSS settle.
    await new Promise((r) => setTimeout(r, 500));
    const rssBytes = await readRssBytes(server.pid);

    const base = `http://127.0.0.1:${port}`;
    const notes = await timedFetch(`${base}/api/notes`);
    const layout = await timedFetch(`${base}/api/graph/layout`);
    const s1 = await timedFetch(`${base}/api/search?q=architecture&limit=20&mode=fulltext`);
    const s2 = await timedFetch(`${base}/api/search?q=incident&limit=20&mode=fulltext`);
    const s3 = await timedFetch(`${base}/api/search?q=bench&limit=20&mode=fulltext`);

    // Second pass for /api/notes so we can see whether it's I/O-bound or
    // pure serialization (there is no caching layer today).
    const notes2 = await timedFetch(`${base}/api/notes`);
    const layout2 = await timedFetch(`${base}/api/graph/layout`);

    // RSS after some work — a rough steady-state number.
    const rssAfterBytes = await readRssBytes(server.pid);

    server.kill('SIGTERM');
    await new Promise((resolve) => {
        const timer = setTimeout(() => {
            server.kill('SIGKILL');
            resolve();
        }, 5000);
        server.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
    });

    await rm(cwd, {recursive: true, force: true}).catch(() => {});

    const report = {
        vault: VAULT,
        bootMs,
        rss: {
            afterBootBytes: rssBytes,
            afterBootLabel: rssBytes !== null ? fmtBytes(rssBytes) : 'n/a',
            steadyBytes: rssAfterBytes,
            steadyLabel: rssAfterBytes !== null ? fmtBytes(rssAfterBytes) : 'n/a'
        },
        notes: {...notes, sizeLabel: fmtBytes(notes.bytes)},
        notes2: {...notes2, sizeLabel: fmtBytes(notes2.bytes)},
        layout: {...layout, sizeLabel: fmtBytes(layout.bytes)},
        layout2: {...layout2, sizeLabel: fmtBytes(layout2.bytes)},
        search: [
            {q: 'architecture', ...s1, sizeLabel: fmtBytes(s1.bytes)},
            {q: 'incident', ...s2, sizeLabel: fmtBytes(s2.bytes)},
            {q: 'bench', ...s3, sizeLabel: fmtBytes(s3.bytes)}
        ]
    };

    console.log('');
    console.log('=== bench report ===');
    console.log(`boot:      ${bootMs} ms`);
    console.log(`rss after boot:   ${report.rss.afterBootLabel}`);
    console.log(`rss steady:       ${report.rss.steadyLabel}`);
    console.log(`/api/notes:       ${notes.status}  ${notes.totalMs} ms  ${report.notes.sizeLabel}   (2nd: ${notes2.totalMs} ms)`);
    console.log(`/api/graph/layout:${layout.status}  ${layout.totalMs} ms  ${report.layout.sizeLabel}   (2nd: ${layout2.totalMs} ms)`);
    for (const s of report.search) {
        console.log(`/api/search?q=${s.q.padEnd(14)}${s.status}  ${s.totalMs} ms  ${s.sizeLabel}`);
    }
    console.log('');
    console.log('json:');
    console.log(JSON.stringify(report, null, 2));
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});