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
const {SynaipseService} = await import('@synaipse/service');
const {GitHubStarsCrawler} = await import('./GitHubStars.js');
const {DevToCrawler} = await import('./DevTo.js');
const {CodeCrawler} = await import('./Code.js');

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

    if (name === 'code') {
        const repoPath = args[1];

        if (repoPath === undefined || repoPath.length === 0) {
            process.stderr.write('usage: npm run crawl:code -- <repo-path> [--with-source] [--name <repoName>]\n');
            return 2;
        }

        const withSource = args.includes('--with-source');
        const nameIdx = args.indexOf('--name');
        const repoName = nameIdx >= 0 ? args[nameIdx + 1] : undefined;

        const crawler = new CodeCrawler({
            repoPath,
            withSource,
            ...(repoName !== undefined ? {repoName} : {})
        });

        log(`[crawler] starting ${crawler.name} (${repoPath}${withSource ? ', with source' : ''})`);
        const report = await crawler.run(ctx);
        log(`[crawler] done in ${(report.elapsedMs / 1000).toFixed(1)}s — walked ${report.walked}, written ${report.written}, unchanged ${report.unchanged}, errors ${report.errors.length}`);

        if (report.errors.length > 0) {
            for (const err of report.errors.slice(0, 10)) {
                log(`  ! ${err.item}: ${err.error}`);
            }
        }

        return report.errors.length === 0 ? 0 : 1;
    }

    if (name === 'compile') {
        const prefix = args[1] ?? 'Crawler/';
        const force = args.includes('--force');
        const limitArg = args.find((a) => a.startsWith('--limit='));
        const limit = limitArg !== undefined ? Number.parseInt(limitArg.slice(8), 10) : Number.POSITIVE_INFINITY;

        const service = new SynaipseService(config);
        await service.start();

        if (!service.chatEnabled()) {
            process.stderr.write('compile requires a configured LLM provider — set SYNAIPSE_CHAT_PROVIDER + model\n');
            return 2;
        }

        const all = service.listNotes();
        const targets = all.filter((n) =>
            n.id.startsWith(prefix)
            && !n.id.endsWith('.compiled.md')
            && (n.frontmatter.source !== 'compiled')
        );

        log(`[compile] ${targets.length} candidates under ${prefix} (model=${service.getChatProviderKind()}:${service.getChatModel()})`);

        let done = 0;
        let skipped = 0;
        let failed = 0;
        const started = Date.now();

        for (const note of targets) {
            if (done + skipped + failed >= limit) break;

            try {
                let compiled = false;

                for await (const event of service.compileNote(note.id, {force})) {
                    if (event.kind === 'error') {
                        log(`[compile] ! ${note.id}: ${event.message}`);
                        failed += 1;
                        break;
                    }

                    if (event.kind === 'done') {
                        if (event.result === null && event.compiledPath !== undefined) {
                            // skipped (no rebuild needed) or JSON parse failed
                            skipped += 1;
                        } else if (event.result !== null) {
                            done += 1;
                            compiled = true;
                            log(`[compile] ✓ ${note.id} → ${event.compiledPath ?? '?'}`);
                        } else {
                            failed += 1;
                            log(`[compile] ! ${note.id}: LLM output did not parse as JSON`);
                        }
                        break;
                    }
                }

                void compiled;
            } catch (cause) {
                failed += 1;
                log(`[compile] ! ${note.id}: ${String(cause)}`);
            }
        }

        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        log(`[compile] done in ${elapsed}s — compiled ${done}, skipped ${skipped}, failed ${failed}`);
        return failed === 0 ? 0 : 1;
    }

    if (name === 'relink') {
        const prefix = args[1] ?? 'Crawler/';
        const force = args.includes('--force');
        const useLlm = args.includes('--llm');
        const limitArg = args.find((a) => a.startsWith('--limit='));
        const limit = limitArg !== undefined ? Number.parseInt(limitArg.slice(8), 10) : Number.POSITIVE_INFINITY;

        const service = new SynaipseService(config);
        await service.start();

        if (useLlm && !service.chatEnabled()) {
            process.stderr.write('relink --llm requires a configured LLM provider — set SYNAIPSE_CHAT_PROVIDER + model\n');
            return 2;
        }

        const all = service.listNotes();
        const targets = all.filter((n) =>
            n.id.startsWith(prefix)
            && !n.id.endsWith('.compiled.md')
        );

        const mode = useLlm ? `llm (${service.getChatProviderKind()}:${service.getChatModel()})` : 'top-5 fulltext';
        log(`[relink] ${targets.length} candidates under ${prefix} (mode=${mode})`);

        let done = 0;
        let skipped = 0;
        let failed = 0;
        const started = Date.now();

        for (const note of targets) {
            if (done + skipped + failed >= limit) break;

            try {
                const result = await service.relinkNote(note.id, {useLlm, force});

                if (result.skipped) {
                    skipped += 1;
                } else if (result.accepted.length === 0) {
                    skipped += 1;
                    log(`[relink] ○ ${note.id} (no related)`);
                } else {
                    done += 1;
                    log(`[relink] ✓ ${note.id} → ${result.accepted.length} links`);
                }
            } catch (cause) {
                failed += 1;
                log(`[relink] ! ${note.id}: ${String(cause)}`);
            }
        }

        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        log(`[relink] done in ${elapsed}s — linked ${done}, skipped ${skipped}, failed ${failed}`);
        return failed === 0 ? 0 : 1;
    }

    process.stderr.write(`unknown crawler: ${name}\n`);
    return 2;
};

process.exit(await runCrawler(crawlerName));