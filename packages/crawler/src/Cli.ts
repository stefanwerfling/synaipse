#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config as dotenvConfig} from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
// here = packages/crawler/dist → up 3 = repo root
const repoRoot = path.resolve(here, '..', '..', '..');
process.chdir(repoRoot);
dotenvConfig({path: path.join(repoRoot, '.env')});

const {loadConfigFromEnv} = await import('@synaipse/core');
const {Vault} = await import('@synaipse/vault');
const {GitHubStarsCrawler} = await import('./GitHubStars.js');
const {DevToCrawler} = await import('./DevTo.js');

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

const runCrawler = async (name: string): Promise<number> => {
    if (name === 'github-stars') {
        const token = process.env.GITHUB_TOKEN;

        if (token === undefined || token.length === 0) {
            process.stderr.write('GITHUB_TOKEN is required\n');
            return 2;
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

        return report.errors.length === 0 ? 0 : 1;
    }

    if (name === 'devto') {
        const apiKey = process.env.DEVTO_API_KEY;

        if (apiKey === undefined || apiKey.length === 0) {
            process.stderr.write('DEVTO_API_KEY is required\n');
            return 2;
        }

        const perPage = Number.parseInt(process.env.DEVTO_PER_PAGE ?? '100', 10);
        const bodyMax = Number.parseInt(process.env.DEVTO_CRAWL_BODY_MAX ?? '3000', 10);
        const downloadImagesRaw = (process.env.DEVTO_DOWNLOAD_IMAGES ?? 'true').toLowerCase();
        const downloadImages = downloadImagesRaw !== 'false' && downloadImagesRaw !== '0' && downloadImagesRaw !== 'no';

        const crawler = new DevToCrawler({
            apiKey,
            perPage: Number.isFinite(perPage) ? perPage : 100,
            bodyMax: Number.isFinite(bodyMax) ? bodyMax : 3000,
            downloadImages
        });

        log(`[crawler] starting ${crawler.name}`);
        const report = await crawler.run(ctx);
        log(`[crawler] done in ${(report.elapsedMs / 1000).toFixed(1)}s — fetched ${report.fetched}, written ${report.written}, unchanged ${report.unchanged}, errors ${report.errors.length}`);

        if (report.errors.length > 0) {
            for (const err of report.errors.slice(0, 10)) {
                log(`  ! ${err.item}: ${err.error}`);
            }
        }

        return report.errors.length === 0 ? 0 : 1;
    }

    process.stderr.write(`unknown crawler: ${name}\n`);
    return 2;
};

process.exit(await runCrawler(crawlerName));