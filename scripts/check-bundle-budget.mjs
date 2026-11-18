#!/usr/bin/env node
// Bundle budget for the web UI (plan P4 / D4). Run after `vite build`:
//
//   npm run build -w packages/web-client && node scripts/check-bundle-budget.mjs
//
// "Initial JS" is what a first page load fetches before any interaction:
// the entry script(s) and every chunk they modulepreload, as listed in
// dist/web/index.html. Lazy chunks get only a per-chunk ceiling that
// catches a big library accidentally pulled into one of them.

import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';

const KB = 1024;

const BUDGET = {
    /** Entry + modulepreloaded chunks, minified. Measured 244 KB on 2026-11-18. */
    initialRaw: 260 * KB,
    /** Same, gzip level 9. Measured 70.5 KB. */
    initialGzip: 80 * KB,
    /** Any single lazy chunk (Graph3D/three.js is the largest, ~1.48 MB). */
    lazyChunkRaw: 1600 * KB
};

const dist = path.resolve(process.argv[2] ?? 'packages/web-client/dist/web');
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');

const initial = new Set();
for (const match of html.matchAll(/<script[^>]+src="\/?([^"]+\.js)"/g)) initial.add(match[1]);
for (const match of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/?([^"]+\.js)"/g)) initial.add(match[1]);

if (initial.size === 0) {
    console.error(`bundle budget: no entry script found in ${path.join(dist, 'index.html')}`);
    process.exit(1);
}

const sizeOf = (rel) => {
    const buf = readFileSync(path.join(dist, rel));
    return {raw: buf.length, gzip: gzipSync(buf, {level: 9}).length};
};

const fmt = (n) => `${(n / KB).toFixed(1)} KB`;
const failures = [];

let raw = 0;
let gzip = 0;
for (const rel of initial) {
    const size = sizeOf(rel);
    raw += size.raw;
    gzip += size.gzip;
    console.log(`  initial  ${fmt(size.raw).padStart(10)}  ${fmt(size.gzip).padStart(9)} gz  ${rel}`);
}

console.log(`initial JS: ${fmt(raw)} (budget ${fmt(BUDGET.initialRaw)}), gzip ${fmt(gzip)} (budget ${fmt(BUDGET.initialGzip)})`);
if (raw > BUDGET.initialRaw) failures.push(`initial JS ${fmt(raw)} > ${fmt(BUDGET.initialRaw)}`);
if (gzip > BUDGET.initialGzip) failures.push(`initial JS gzip ${fmt(gzip)} > ${fmt(BUDGET.initialGzip)}`);

const assets = path.join(dist, 'assets');
for (const file of readdirSync(assets)) {
    const rel = `assets/${file}`;
    if (!file.endsWith('.js') || initial.has(rel)) continue;
    const size = sizeOf(rel);
    if (size.raw > BUDGET.lazyChunkRaw) failures.push(`lazy chunk ${rel} ${fmt(size.raw)} > ${fmt(BUDGET.lazyChunkRaw)}`);
}

if (failures.length > 0) {
    console.error(`bundle budget exceeded:\n  ${failures.join('\n  ')}`);
    console.error('Load the new dependency lazily (dynamic import) or raise the budget in scripts/check-bundle-budget.mjs on purpose.');
    process.exit(1);
}

console.log('bundle budget ok');
