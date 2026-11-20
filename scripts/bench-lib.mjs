// Shared helpers for the scale benchmarks (bench-scale.mjs, bench-gate.mjs):
// boot the built web API against a vault in isolation and talk to it.

import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

export const findFreePort = () => new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        srv.close(() => resolve(port));
    });
});

export const readRssBytes = async (pid) => {
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

export const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
};

/** Nearest-rank percentile of a list of numbers. */
export const percentile = (values, p) => {
    if (values.length === 0) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
};

export const median = (values) => percentile(values, 50);

/**
 * Environment for an isolated local-mode server: no repo .env (the caller
 * runs it with a temp cwd), no embeddings, no git, no Qdrant, no chat. Only
 * PATH/HOME/locale come from the parent, so nothing of the developer's own
 * setup (vault path, tokens, keys) leaks in.
 */
export const isolatedEnv = (vault, port, extra = {}) => {
    const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'];
    const env = {};
    for (const key of keep) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return {
        ...env,
        SYNAIPSE_MODE: 'local',
        SYNAIPSE_VAULT_PATH: vault,
        SYNAIPSE_STATE_DB: path.join(vault, '.synaipse', 'state.db'),
        EMBEDDINGS_PROVIDER: 'none',
        SYNAIPSE_GIT_AUTOCOMMIT: 'false',
        QDRANT_URL: 'http://127.0.0.1:9',
        OLLAMA_URL: 'http://127.0.0.1:9',
        WEB_API_PORT: String(port),
        SYNAIPSE_STATIC_DIR: '',
        ...extra
    };
};

/**
 * Start the built web API from `repoRoot` and resolve once it listens.
 * `waitFor(needle, timeoutMs)` waits for a later log line (stdout or stderr).
 */
export const bootServer = async ({repoRoot, vault, cwd, timeoutMs = 300_000, extraEnv = {}}) => {
    const port = await findFreePort();
    const entry = path.join(repoRoot, 'packages/web-api/dist/server/index.js');
    const started = performance.now();
    const child = spawn(process.execPath, [entry], {
        cwd,
        env: isolatedEnv(vault, port, extraEnv),
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let log = '';
    const waiters = new Set();
    const onData = (chunk) => {
        log += chunk.toString();
        for (const w of waiters) w();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const waitFor = (needle, ms = timeoutMs) => new Promise((resolve, reject) => {
        const check = () => {
            const match = typeof needle === 'string'
                ? (log.includes(needle) ? needle : null)
                : log.match(needle);
            if (match !== null) {
                waiters.delete(check);
                clearTimeout(timer);
                resolve(match);
            }
        };
        const timer = setTimeout(() => {
            waiters.delete(check);
            reject(new Error(`timeout after ${ms} ms waiting for ${String(needle)}; log tail:\n${log.slice(-3000)}`));
        }, ms);
        waiters.add(check);
        check();
    });

    const exited = new Promise((resolve) => child.once('exit', resolve));
    const stop = async () => {
        if (child.exitCode !== null) return;
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
        await exited;
        clearTimeout(timer);
    };

    try {
        await Promise.race([
            waitFor('listening on'),
            exited.then((code) => {
                throw new Error(`server exited with ${code} before listening; log tail:\n${log.slice(-3000)}`);
            })
        ]);
    } catch (err) {
        await stop();
        throw err;
    }

    return {
        child,
        base: `http://127.0.0.1:${port}`,
        bootMs: Math.round(performance.now() - started),
        waitFor,
        stop,
        log: () => log
    };
};

export const timedFetch = async (url, init) => {
    const t0 = performance.now();
    const res = await fetch(url, init);
    const headerMs = performance.now() - t0;
    const lengthHeader = Number(res.headers.get('content-length') ?? '0') || null;
    const body = await res.text();
    const totalMs = performance.now() - t0;
    if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} → ${res.status}: ${body.slice(0, 300)}`);
    return {
        status: res.status,
        headerMs: Math.round(headerMs),
        totalMs,
        bytes: lengthHeader ?? Buffer.byteLength(body, 'utf8')
    };
};
