#!/usr/bin/env node
// Live integration test against a running Ollama container.
// Seeds a temp vault, runs service.chat() with a real prompt, prints the stream.
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const url = process.env.SYNAIPSE_CHAT_URL ?? 'http://localhost:11434';
const model = process.env.SYNAIPSE_CHAT_MODEL ?? 'gemma3:4b';

console.log(`[live-test] ollama ${url} · model ${model}`);

// 1. probe ollama
const ping = await fetch(`${url}/api/tags`).catch(() => null);
if (ping === null || !ping.ok) {
    console.error(`[live-test] ollama not reachable at ${url}`);
    process.exit(1);
}
const tags = await ping.json();
const have = (tags.models ?? []).map((m) => m.name);
console.log(`[live-test] models present: ${have.join(', ') || '(none)'}`);

if (!have.some((n) => n.startsWith(model.split(':')[0]))) {
    console.error(`[live-test] model ${model} not pulled — wait for ollama-init to finish`);
    process.exit(1);
}

// 2. seed a vault
const root = await mkdtemp(path.join(tmpdir(), 'synaipse-live-chat-'));
const seed = async (rel, body) => {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), {recursive: true});
    await writeFile(abs, body, 'utf8');
};

await seed('Memory/decisions/2026-06-11-backendcluster.md',
    '---\ntitle: BackendCluster Decision\ntags: [decision, cluster, adr]\n---\n'
    + '# BackendCluster\n\n'
    + 'Am 2026-06-11 wurde entschieden, die Cluster-Logik aus der BackendApp auszulagern, '
    + 'weil die Codebasis zu groß für einen einzelnen Process geworden war. '
    + 'Der neue Cluster läuft als separater Prozess-Pool, ServiceManager regelt die Start-Reihenfolge.');

await seed('Memory/architecture/service-manager.md',
    '---\ntitle: ServiceManager\ntags: [architecture]\n---\n'
    + '# ServiceManager\n\n'
    + 'Der ServiceManager initialisiert alle Backend-Komponenten in einer definierten '
    + 'Reihenfolge: zuerst Logger, dann ConfigStore, dann BackendCluster, zuletzt Worker.');

await seed('Memory/research/random.md',
    '---\ntitle: Random Stuff\ntags: [misc]\n---\n# Random\n\nKochrezepte, Katzen, alles was sonst so anfällt.');

console.log(`[live-test] vault seeded at ${root}`);

// 3. import service via dist (we built earlier)
const {SynaipseService} = await import('../packages/service/dist/Index.js');

const service = new SynaipseService({
    vaultPath: root,
    indexCachePath: path.join(root, '.cache.json'),
    embeddings: {provider: 'none'},
    qdrant: {url: 'http://localhost:6333', collection: 'live-test'},
    server: {name: 'synaipse-live', version: '0.0.0'},
    web: {port: 0},
    chat: {provider: 'ollama', url, model}
});

await service.start();

// 4. run chat
const question = 'Warum wurde BackendCluster eingeführt und welche Komponente regelt die Start-Reihenfolge?';
console.log(`\n[live-test] question: ${question}\n`);

let started = false;
let tokenBuffer = '';
const t0 = Date.now();

for await (const event of service.chat({question})) {
    if (event.kind === 'start') {
        started = true;
        console.log(`[live-test] sources retrieved by hybrid search:`);
        for (const s of event.sources) {
            console.log(`  [^${s.index}] ${s.title}  (${s.noteId})  score=${s.score.toFixed(3)}`);
        }
        console.log(`\n[live-test] streaming answer (model ${event.model}):`);
        process.stdout.write('  > ');
    } else if (event.kind === 'token') {
        tokenBuffer += event.text;
        process.stdout.write(event.text);
    } else if (event.kind === 'done') {
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`\n\n[live-test] done in ${dt}s · ${event.totalTokens} tokens`);
    } else if (event.kind === 'error') {
        console.error(`\n[live-test] error: ${event.message}`);
        process.exit(1);
    }
}

await service.stop();
await rm(root, {recursive: true, force: true});

if (!started || tokenBuffer.length === 0) {
    console.error('[live-test] FAIL — never got a streamed answer');
    process.exit(1);
}

console.log('\n[live-test] OK ✓');