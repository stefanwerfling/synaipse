#!/usr/bin/env node
// Boot the web server against a synthetic vault and measure:
//   - boot-to-listening time
//   - server-process RSS after boot
//   - /api/notes response time + payload size
//   - /api/graph/layout response time + payload size
//   - /api/search timing for a few queries
//
// Usage:
//   node scripts/bench-scale.mjs --vault=/tmp/vault-5k
//
// For the CI gate with baseline comparison see bench-gate.mjs.
//
// Assumes the web package is already built (packages/web-api/dist/server).
// Doesn't touch the user's real vault or .env — cwd is set to a temp dir
// so dotenv can't pick up the repo-root .env, and every relevant SYNAIPSE_*
// var is passed explicitly.

import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bootServer, fmtBytes, readRssBytes, timedFetch as fetchTimed} from './bench-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v ?? true];
    })
);

const VAULT = path.resolve(args.vault ?? '/tmp/synaipse-bench-vault-5000');

const timedFetch = async (url) => {
    const r = await fetchTimed(url);
    return {...r, totalMs: Math.round(r.totalMs)};
};

const main = async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'synaipse-bench-'));
    console.log(`vault:     ${VAULT}`);
    console.log(`cwd:       ${cwd}`);
    console.log('');

    let server;
    try {
        server = await bootServer({repoRoot, vault: VAULT, cwd, timeoutMs: 240_000});
    } catch (err) {
        console.error(String(err));
        process.exit(1);
    }
    const bootMs = server.bootMs;

    // Give the server a beat to finish any post-listen background work
    // (last-mile index warmup, etc.) and let RSS settle.
    await new Promise((r) => setTimeout(r, 500));
    const rssBytes = await readRssBytes(server.child.pid);

    const base = server.base;
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
    const rssAfterBytes = await readRssBytes(server.child.pid);

    await server.stop();

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