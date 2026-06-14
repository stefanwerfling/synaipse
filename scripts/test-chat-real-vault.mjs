#!/usr/bin/env node
// Live chat test against the user's real vault.
// Loads the actual SYNAIPSE_VAULT_PATH from .env, asks several questions
// across Memory + Crawler, prints sources + streamed answers.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config as dotenvConfig} from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
process.chdir(repoRoot);
dotenvConfig();

const url = process.env.SYNAIPSE_CHAT_URL ?? 'http://localhost:11434';
const model = process.env.SYNAIPSE_CHAT_MODEL ?? 'gemma3:4b';
const vaultPath = process.env.SYNAIPSE_VAULT_PATH;

if (vaultPath === undefined) {
    console.error('SYNAIPSE_VAULT_PATH not set in .env');
    process.exit(1);
}

console.log(`[real-vault] ollama ${url} · model ${model}`);
console.log(`[real-vault] vault ${vaultPath}\n`);

const {SynaipseService} = await import('../packages/service/dist/Index.js');

const useSemantic = process.env.TEST_SEMANTIC !== 'false';

const service = new SynaipseService({
    vaultPath,
    indexCachePath: '/tmp/synaipse-real-vault-chat.json',
    embeddings: {provider: useSemantic ? 'ollama' : 'none'},
    ollama: {url: process.env.OLLAMA_URL ?? 'http://localhost:11434', model: 'nomic-embed-text'},
    qdrant: {url: process.env.QDRANT_URL ?? 'http://localhost:6333', collection: 'live-chat-test'},
    server: {name: 'live', version: '0.0.0'},
    web: {port: 0},
    chat: {provider: 'ollama', url, model}
});

if (useSemantic) console.log(`[real-vault] using hybrid search (nomic-embed-text → qdrant)\n`);

await service.start();

const ask = async (label, question, opts = {}) => {
    console.log('\n' + '═'.repeat(78));
    console.log(`▶ ${label}`);
    console.log(`Q: ${question}`);
    if (opts.pathPrefix !== undefined) console.log(`scope: ${opts.pathPrefix}`);
    console.log('─'.repeat(78));

    const t0 = Date.now();
    let tokens = 0;

    for await (const event of service.chat({question, ...opts})) {
        if (event.kind === 'start') {
            console.log(`sources (${event.sources.length}):`);
            for (const s of event.sources.slice(0, 5)) {
                console.log(`  [^${s.index}] ${s.title}  ·  ${s.noteId}  (score ${s.score.toFixed(2)})`);
            }
            if (event.sources.length > 5) console.log(`  … +${event.sources.length - 5} more`);
            process.stdout.write('\n  ');
        } else if (event.kind === 'token') {
            process.stdout.write(event.text);
            tokens += 1;
        } else if (event.kind === 'done') {
            const dt = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`\n\n[${dt}s · ${event.totalTokens || tokens} tokens]`);
        } else if (event.kind === 'error') {
            console.error(`\n[error] ${event.message}`);
        }
    }
};

await ask(
    '1. Memory — swipemeister Standards',
    'Welche Conventions habe ich für Logger im swipemeister-Projekt definiert?'
);

await ask(
    '2. Memory — Auth',
    'Wie sind Authentication-Callbacks im swipemeister-Projekt aufgebaut?'
);

await ask(
    '3. Crawler/devto — Themenüberblick',
    'Was wurde kürzlich zu MCP (Model Context Protocol) geschrieben?',
    {pathPrefix: 'Crawler/devto/'}
);

await ask(
    '4. Crawler/github — Sprachen',
    'Habe ich Rust-Repositories gestarred? Wenn ja, welche?',
    {pathPrefix: 'Crawler/github/'}
);

await ask(
    '5. Cross-Vault — Konzept',
    'Welche Tools nutze ich für Schema-Editing?'
);

await service.stop();
console.log('\n' + '═'.repeat(78));
console.log('✓ done');