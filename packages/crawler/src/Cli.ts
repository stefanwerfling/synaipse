#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config as dotenvConfig} from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
process.chdir(repoRoot);
dotenvConfig();

const {loadConfigFromEnv} = await import('@synaipse/core');
const {Vault} = await import('@synaipse/vault');
const {GitHubStarsCrawler} = await import('./GitHubStars.js');

const args = process.argv.slice(2);
const crawlerName = args[0] ?? 'github-stars';

const config = loadConfigFromEnv();
const vault = new Vault(config.vaultPath, {
    history: {
        autoCommit: config.git?.autoCommit ?? true,
        author: config.git?.author ?? {name: 'Synaipse Crawler', email: 'crawler@synaipse.local'}
    }
});

await vault.load();

const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
};

const ctx = {vault, log};

if (crawlerName === 'github-stars') {
    const token = process.env.GITHUB_TOKEN;

    if (token === undefined || token.length === 0) {
        process.stderr.write('GITHUB_TOKEN is required\n');
        process.exit(2);
    }

    const username = process.env.GITHUB_USERNAME;
    const readmeMax = Number.parseInt(process.env.GITHUB_CRAWL_README_MAX ?? '3000', 10);

    const crawler = new GitHubStarsCrawler({
        token,
        ...(username !== undefined && username.length > 0 ? {username} : {}),
        readmeMax: Number.isFinite(readmeMax) ? readmeMax : 3000
    });

    log(`[crawler] starting ${crawler.name}`);
    const report = await crawler.run(ctx);
    log(`[crawler] done in ${(report.elapsedMs / 1000).toFixed(1)}s — fetched ${report.fetched}, written ${report.written}, unchanged ${report.unchanged}, errors ${report.errors.length}`);

    if (report.errors.length > 0) {
        for (const err of report.errors.slice(0, 10)) {
            log(`  ! ${err.item}: ${err.error}`);
        }
    }

    process.exit(report.errors.length === 0 ? 0 : 1);
}

process.stderr.write(`unknown crawler: ${crawlerName}\n`);
process.exit(2);