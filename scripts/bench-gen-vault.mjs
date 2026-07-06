#!/usr/bin/env node
// Generate a synthetic vault for scale benchmarking.
//
// Usage: node scripts/bench-gen-vault.mjs --count=5000 --out=/tmp/vault-5k [--seed=1]
//
// Each note has:
//   - unique title "Bench Note NNNNN"
//   - 3-4 tags from a fixed pool
//   - ~150-word lorem body
//   - 5-10 wikilinks to other bench notes (by title)
//   - inline #hashtag near the top
//
// Directory layout mirrors realistic vault use — ~50 group folders under
// Memory/Bench/gNN so path-parsing paths aren't all in one directory.

import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v ?? true];
    })
);

const COUNT = Number.parseInt(args.count ?? '5000', 10);
const OUT = path.resolve(args.out ?? `/tmp/synaipse-bench-vault-${COUNT}`);
const SEED = Number.parseInt(args.seed ?? '1', 10);

// mulberry32 — deterministic PRNG so runs are comparable.
const rng = (() => {
    let s = SEED >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
})();

const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const pickN = (arr, n) => {
    const copy = [...arr];
    const out = [];
    for (let i = 0; i < n && copy.length > 0; i++) {
        const idx = Math.floor(rng() * copy.length);
        out.push(copy.splice(idx, 1)[0]);
    }
    return out;
};

const TAG_POOL = [
    'architecture', 'decision', 'library', 'infrastructure', 'typescript',
    'bug', 'research', 'code-pattern', 'perf', 'security', 'testing',
    'devops', 'database', 'api', 'ui', 'graph', 'search', 'auth',
    'observability', 'migration', 'refactor', 'feature', 'todo',
    'idea', 'question', 'note', 'reference', 'howto', 'incident', 'postmortem'
];

const LOREM_WORDS = (
    'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
  + 'incididunt ut labore et dolore magna aliqua enim minim veniam quis nostrud '
  + 'exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute '
  + 'irure reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur '
  + 'sint occaecat cupidatat proident sunt culpa qui officia deserunt mollit anim '
  + 'the quick brown fox jumps over lazy dog pack my box with five dozen liquor jugs '
  + 'systems that scale require careful measurement observation and iteration'
).split(/\s+/);

const titleFor = (i) => `Bench Note ${String(i).padStart(6, '0')}`;
const filenameFor = (i) => `note-${String(i).padStart(6, '0')}.md`;
const groupFor = (i) => `g${String(i % 50).padStart(2, '0')}`;

const body = (index, links) => {
    const words = [];
    const target = 120 + Math.floor(rng() * 80);
    for (let i = 0; i < target; i++) {
        words.push(pick(LOREM_WORDS));
    }

    const chunks = [];
    // A hashtag near the top so the inline-tag parser has something to catch.
    chunks.push(`#bench-${index % 30}\n`);
    chunks.push(words.slice(0, 40).join(' ') + '.');
    chunks.push('');
    chunks.push('Related:');
    for (const link of links) {
        chunks.push(`- [[${link}]]`);
    }
    chunks.push('');
    chunks.push(words.slice(40, 100).join(' ') + '.');
    chunks.push('');
    chunks.push(words.slice(100).join(' ') + '.');
    return chunks.join('\n');
};

const noteContent = (i) => {
    const tags = pickN(TAG_POOL, 3 + Math.floor(rng() * 2));
    // 5-10 wikilinks to other bench notes. Pick from a sliding window so
    // the resulting graph is locally-dense rather than uniformly random.
    const linkCount = 5 + Math.floor(rng() * 6);
    const links = [];
    for (let k = 0; k < linkCount; k++) {
        const jitter = Math.floor(rng() * 200) - 100;
        const target = ((i + jitter) % COUNT + COUNT) % COUNT;
        if (target !== i) links.push(titleFor(target));
    }

    const fm = [
        '---',
        `title: ${titleFor(i)}`,
        `tags: [${tags.join(', ')}]`,
        'created: 2024-01-01',
        'updated: 2024-06-01',
        '---',
        ''
    ].join('\n');

    return fm + body(i, links) + '\n';
};

const main = async () => {
    console.log(`generating ${COUNT} notes into ${OUT} (seed=${SEED})`);
    const started = Date.now();

    // Pre-create the group directories so we're not racing mkdir on every write.
    const groups = new Set();
    for (let i = 0; i < COUNT; i++) groups.add(groupFor(i));
    for (const g of groups) {
        await mkdir(path.join(OUT, 'Memory', 'Bench', g), {recursive: true});
    }

    let bytes = 0;
    let done = 0;

    // Batch writes to keep the fd pressure reasonable but still get parallelism.
    const BATCH = 200;
    for (let start = 0; start < COUNT; start += BATCH) {
        const end = Math.min(start + BATCH, COUNT);
        await Promise.all(
            Array.from({length: end - start}, (_, k) => {
                const i = start + k;
                const content = noteContent(i);
                bytes += content.length;
                const file = path.join(OUT, 'Memory', 'Bench', groupFor(i), filenameFor(i));
                return writeFile(file, content, 'utf8');
            })
        );
        done = end;
        if (done % 5000 === 0 || done === COUNT) {
            const pct = ((done / COUNT) * 100).toFixed(1);
            process.stdout.write(`  ${done}/${COUNT} (${pct}%)\r`);
        }
    }

    const ms = Date.now() - started;
    console.log(`\ndone in ${ms} ms — ${(bytes / (1024 * 1024)).toFixed(1)} MiB total, avg ${(bytes / COUNT).toFixed(0)} B/note`);
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});