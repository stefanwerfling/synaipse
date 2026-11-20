#!/usr/bin/env node
// Scale benchmark gate (plan A7).
//
// For each vault size: generate a deterministic synthetic vault, boot the
// built web API on it twice (cold: no index cache, warm: with it) and
// measure cold/warm start, Atlas layout time, RSS, search p95 and write
// p95. Optionally compare against a baseline result and fail on
// regressions, and/or record the numbers in a Synaipse project's
// benchmark set (the same data synaipse_benchmark_add writes).
//
// Usage:
//   node scripts/bench-gate.mjs [--sizes=10000,50000] [--out=bench-result.json]
//       [--baseline=bench-baseline.json] [--threshold=0.2]
//       [--machine=label] [--record-url=http://127.0.0.1:3001 --project=synaipse]
//
// Exit codes: 0 ok (or no baseline), 1 regression, 2 the run itself failed.
// Needs a built web API (npm run build). Never touches the developer's
// vault or .env: every server runs with a temp cwd and an explicit env.

import {execFileSync, spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bootServer, fmtBytes, median, percentile, readRssBytes, timedFetch} from './bench-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length > 0 ? v.join('=') : true];
}));

const SIZES = String(args.sizes ?? '10000,50000').split(',').map((s) => Number.parseInt(s, 10)).filter((n) => n > 0);
const OUT = args.out !== undefined ? path.resolve(String(args.out)) : null;
const BASELINE = args.baseline !== undefined ? path.resolve(String(args.baseline)) : null;
const THRESHOLD = args.threshold !== undefined ? Number(args.threshold) : 0.2;
const MACHINE = String(args.machine ?? `${os.platform()}-${os.arch()}-${os.cpus().length}cpu`);
const SEARCH_SAMPLES = Number(args['search-samples'] ?? 60);
const WRITE_SAMPLES = Number(args['write-samples'] ?? 60);

/**
 * What is gated. `slack` is an absolute margin: a regression must exceed
 * both the relative threshold and this, so a 3 → 4 ms p95 (33 %) on a
 * shared CI runner does not fail the build.
 */
export const METRICS = {
    coldStartMs: {unit: 'ms', slack: 400, label: 'cold start'},
    warmStartMs: {unit: 'ms', slack: 400, label: 'warm start'},
    layoutMs: {unit: 'ms', slack: 200, label: 'layout'},
    rssMiB: {unit: 'MiB', slack: 64, label: 'RSS'},
    searchP95Ms: {unit: 'ms', slack: 15, label: 'search p95'},
    writeP95Ms: {unit: 'ms', slack: 15, label: 'write p95'}
};

const SEARCH_QUERIES = ['architecture', 'incident', 'bench', 'quick brown fox', 'careful measurement', 'Bench Note 000123', 'database migration', 'lorem'];

const run = (cmd, cmdArgs) => new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {stdio: ['ignore', 'ignore', 'inherit']});
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${cmdArgs.join(' ')} exited ${code}`))));
});

const gitCommit = () => {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: repoRoot, encoding: 'utf8'}).trim();
    } catch {
        return null;
    }
};

const layoutMsFrom = async (server) => {
    const line = await server.waitFor(/layout warmed[^\n]*?\bms=(\d+)/, 600_000);
    return Number(line[1]);
};

const measureSearch = async (base) => {
    // One untimed pass so the first query does not pay for JIT.
    for (const q of SEARCH_QUERIES) await timedFetch(`${base}/api/search?q=${encodeURIComponent(q)}&limit=20&mode=fulltext`);
    const samples = [];
    for (let i = 0; i < SEARCH_SAMPLES; i++) {
        const q = SEARCH_QUERIES[i % SEARCH_QUERIES.length];
        samples.push((await timedFetch(`${base}/api/search?q=${encodeURIComponent(q)}&limit=20&mode=fulltext`)).totalMs);
    }
    return samples;
};

const measureWrites = async (base, count) => {
    const samples = [];
    for (let i = 0; i < WRITE_SAMPLES; i++) {
        // Alternate between updating an existing note (re-link, re-index) and creating a new one.
        const target = i % 2 === 0
            ? `Memory/Bench/g${String((i * 7) % 50).padStart(2, '0')}/note-${String((i * 7919) % count).padStart(6, '0')}.md`
            : `Memory/Bench/gate/new-${String(i).padStart(4, '0')}.md`;
        const body = JSON.stringify({
            content: `Gate write ${i}. See [[Bench Note ${String((i * 31) % count).padStart(6, '0')}]] and [[Bench Note ${String((i * 97) % count).padStart(6, '0')}]].\n`,
            frontmatter: {title: i % 2 === 0 ? `Bench Note ${String((i * 7919) % count).padStart(6, '0')}` : `Gate Note ${i}`, tags: ['bench', 'gate']}
        });
        const url = `${base}/api/notes/${target.split('/').map(encodeURIComponent).join('/')}`;
        samples.push((await timedFetch(url, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body})).totalMs);
    }
    return samples;
};

const benchSize = async (count) => {
    const work = await mkdtemp(path.join(os.tmpdir(), `synaipse-gate-${count}-`));
    const vault = path.join(work, 'vault');
    const cwd = path.join(work, 'cwd');
    await run('mkdir', ['-p', cwd]);
    try {
        process.stdout.write(`[${count}] generating vault … `);
        await run(process.execPath, [path.join(here, 'bench-gen-vault.mjs'), `--count=${count}`, `--out=${vault}`, '--seed=1']);
        console.log('ok');

        process.stdout.write(`[${count}] cold boot … `);
        const cold = await bootServer({repoRoot, vault, cwd});
        let result;
        try {
            const layoutMs = await layoutMsFrom(cold);
            console.log(`${cold.bootMs} ms, layout ${layoutMs} ms`);
            const search = await measureSearch(cold.base);
            const writes = await measureWrites(cold.base, count);
            // A few seconds for the debounced layout recompute and GC to settle before RSS.
            await new Promise((r) => setTimeout(r, 2000));
            const rss = await readRssBytes(cold.child.pid);
            result = {
                coldStartMs: cold.bootMs,
                layoutMs,
                rssMiB: rss !== null ? Math.round(rss / (1024 * 1024)) : null,
                searchP95Ms: round1(percentile(search, 95)),
                searchMedianMs: round1(median(search)),
                writeP95Ms: round1(percentile(writes, 95)),
                writeMedianMs: round1(median(writes))
            };
        } finally {
            await cold.stop();
        }

        process.stdout.write(`[${count}] warm boot … `);
        const warm = await bootServer({repoRoot, vault, cwd});
        result.warmStartMs = warm.bootMs;
        await warm.stop();
        console.log(`${warm.bootMs} ms`);
        return result;
    } finally {
        await rm(work, {recursive: true, force: true});
    }
};

const round1 = (n) => Math.round(n * 10) / 10;

/** Pure: which metrics of `current` regressed against `baseline`. */
export const compare = (current, baseline, threshold = 0.2) => {
    const rows = [];
    for (const [size, metrics] of Object.entries(current.sizes)) {
        const before = baseline?.sizes?.[size];
        for (const [key, spec] of Object.entries(METRICS)) {
            const now = metrics[key];
            const was = before?.[key];
            if (typeof now !== 'number') continue;
            const regressed = typeof was === 'number' && now > was * (1 + threshold) && now - was > spec.slack;
            rows.push({size: Number(size), key, label: spec.label, unit: spec.unit, now, was: typeof was === 'number' ? was : null, regressed});
        }
    }
    return rows;
};

const fmtDelta = (row) => {
    if (row.was === null) return 'no baseline';
    if (row.was === 0) return row.now === 0 ? '±0 %' : 'new';
    const pct = ((row.now - row.was) / row.was) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)} %`;
};

/** Append this run to a project's benchmark set over the web API (same store synaipse_benchmark_add writes). */
const record = async (url, project, result) => {
    const endpoint = `${url.replace(/\/$/, '')}/api/benchmark?project=${encodeURIComponent(project)}`;
    const headers = {'Content-Type': 'application/json'};
    if (process.env.SYNAIPSE_BENCH_COOKIE) headers.Cookie = process.env.SYNAIPSE_BENCH_COOKIE;
    const res = await fetch(endpoint, {headers});
    if (!res.ok) throw new Error(`GET ${endpoint} → ${res.status}`);
    const set = await res.json();
    const recordedAt = result.createdAt;
    const entries = [...(set.entries ?? [])];
    for (const [size, metrics] of Object.entries(result.sizes)) {
        for (const [key, spec] of Object.entries(METRICS)) {
            if (typeof metrics[key] !== 'number') continue;
            entries.push({
                id: `b_${crypto.randomUUID().slice(0, 8)}`,
                dimensions: {suite: 'scale-gate', notes: String(size), machine: result.machine},
                metric: key,
                value: metrics[key],
                unit: spec.unit,
                higherIsBetter: false,
                context: `bench-gate${result.commit ? ` @ ${result.commit}` : ''}, node ${result.node}`,
                recordedAt
            });
        }
    }
    const put = await fetch(endpoint, {method: 'PUT', headers, body: JSON.stringify({entries})});
    if (!put.ok) throw new Error(`PUT ${endpoint} → ${put.status}: ${(await put.text()).slice(0, 200)}`);
};

const main = async () => {
    const result = {
        version: 1,
        createdAt: new Date().toISOString(),
        commit: gitCommit(),
        node: process.version,
        machine: MACHINE,
        sizes: {}
    };
    for (const size of SIZES) {
        result.sizes[size] = await benchSize(size);
    }

    if (OUT !== null) await writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`);

    let baseline = null;
    if (BASELINE !== null) {
        try {
            baseline = JSON.parse(await readFile(BASELINE, 'utf8'));
        } catch {
            console.log(`\nno baseline at ${BASELINE}; this run only reports`);
        }
    }

    const rows = compare(result, baseline, THRESHOLD);
    console.log('\n=== bench gate ===');
    for (const row of rows) {
        const now = row.unit === 'MiB' ? fmtBytes(row.now * 1024 * 1024) : `${row.now} ${row.unit}`;
        console.log(`${String(row.size).padStart(6)}  ${row.label.padEnd(11)} ${now.padStart(12)}  ${fmtDelta(row).padEnd(12)}${row.regressed ? 'REGRESSION' : ''}`);
    }

    if (args['record-url'] !== undefined) {
        if (args.project === undefined) throw new Error('--record-url needs --project');
        await record(String(args['record-url']), String(args.project), result);
        console.log(`\nrecorded in project ${args.project}`);
    }

    const regressions = rows.filter((r) => r.regressed);
    if (regressions.length > 0) {
        console.log(`\n${regressions.length} regression(s) over ${Math.round(THRESHOLD * 100)} % (and over the absolute slack)`);
        process.exitCode = 1;
    }
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(err);
        process.exitCode = 2;
    });
}
