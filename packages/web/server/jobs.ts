import {randomUUID} from 'node:crypto';
import type {SynaipseService} from '@synaipse/service';
import {
    CodeCrawler,
    DevToCrawler,
    GiteaIssuesCrawler,
    GitHubStarsCrawler,
    type CrawlerReport,
    type GiteaIssueState
} from '@synaipse/crawler';

/**
 * In-process job manager. Wraps the service's bulk methods (relink, compile,
 * …) into long-running jobs the frontend can launch, watch and stop. Single
 * service instance → single vault watcher → no cache race vs the CLI tools.
 *
 * State is in-memory; restarting the server loses active+history. That's fine
 * for MVP — jobs are short, restart-rare, and the writes themselves are
 * already persisted via vault commits.
 */

export type JobType =
    | 'relink'
    | 'compile'
    | 'crawl-gitea'
    | 'crawl-devto'
    | 'crawl-github-stars'
    | 'crawl-code';

export type JobStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface RelinkJobParams {
    prefix: string;
    force?: boolean;
    useLlm?: boolean;
    limit?: number;
}

export interface CompileJobParams {
    prefix: string;
    force?: boolean;
    limit?: number;
}

export interface CrawlGiteaJobParams {
    /** Gitea instance root, e.g. https://gitea.example.com (or `.../api/v1`). */
    baseUrl: string;
    /** Repository owner (user or org login). */
    owner: string;
    /** Repository name. */
    repo: string;
    /** Project name — becomes the target folder + frontmatter.project. */
    project: string;
    /** Optional personal-access-token; required for private repos. */
    token?: string;
    /** Issue state filter; default 'open'. */
    state?: GiteaIssueState;
    /** Only pull issues updated on/after this ISO timestamp (delta refresh). */
    since?: string;
}

export interface CrawlDevtoJobParams {
    /** dev.to API key. If omitted, the server falls back to DEVTO_API_KEY. */
    apiKey?: string;
    /** Articles per page (default 100). */
    perPage?: number;
    /** Max body chars fetched per article; 0 skips the per-article fetch. */
    bodyMax?: number;
    /** Target vault folder (default Crawler/devto/articles). */
    pathPrefix?: string;
    /** Download inline images to the vault (default true). */
    downloadImages?: boolean;
}

export interface CrawlGithubStarsJobParams {
    /** GitHub token. If omitted, the server falls back to GITHUB_TOKEN. */
    token?: string;
    /** GitHub username; if omitted the token's own user is used. */
    username?: string;
    /** Max README chars per repo (default 3000). */
    readmeMax?: number;
    /** Target vault folder (default Crawler/github/starred). */
    pathPrefix?: string;
}

export interface CrawlCodeJobParams {
    /** Absolute path to a repository ON THE SERVER host. */
    repoPath: string;
    /** Display/folder name; defaults to the repoPath basename. */
    repoName?: string;
    /** Include full source in each note body. */
    withSource?: boolean;
}

export type JobParams =
    | RelinkJobParams
    | CompileJobParams
    | CrawlGiteaJobParams
    | CrawlDevtoJobParams
    | CrawlGithubStarsJobParams
    | CrawlCodeJobParams;

export interface JobRecord {
    id: string;
    type: JobType;
    params: JobParams;
    status: JobStatus;
    progress: {done: number; total: number; failed: number; current?: string};
    startedAt: number;
    finishedAt?: number;
    error?: string;
    summary?: string;
    /**
     * Set when this run was launched from a persistent schedule (scheduled
     * tick or a manual "run now"). Lets the frontend attach a running job's
     * live progress/log stream to the matching row in the job list.
     */
    scheduleId?: string;
    /** Last 50 log lines. */
    logs: string[];
}

export type JobEvent =
    | {kind: 'progress'; done: number; total: number; failed: number; current?: string}
    | {kind: 'log'; message: string}
    | {kind: 'done'; summary: string}
    | {kind: 'failed'; error: string}
    | {kind: 'stopped'};

type Listener = (event: JobEvent) => void;

const MAX_LOG_LINES = 50;
const MAX_HISTORY = 30;

export class JobManager {
    private readonly jobs = new Map<string, JobRecord>();
    private readonly aborts = new Map<string, AbortController>();
    private readonly subscribers = new Map<string, Set<Listener>>();

    public constructor(private readonly service: SynaipseService) {}

    public startJob(type: JobType, params: JobParams, opts?: {scheduleId?: string}): JobRecord {
        const id = randomUUID();
        const job: JobRecord = {
            id,
            type,
            params,
            status: 'running',
            progress: {done: 0, total: 0, failed: 0},
            startedAt: Date.now(),
            ...(opts?.scheduleId !== undefined ? {scheduleId: opts.scheduleId} : {}),
            logs: []
        };

        this.jobs.set(id, job);
        this.evictHistory();

        const abort = new AbortController();
        this.aborts.set(id, abort);

        void this.execute(job, abort.signal).catch((cause: unknown) => {
            this.fail(id, cause instanceof Error ? cause.message : String(cause));
        });

        return job;
    }

    public listJobs(): JobRecord[] {
        return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
    }

    public getJob(id: string): JobRecord | undefined {
        return this.jobs.get(id);
    }

    public stopJob(id: string): boolean {
        const abort = this.aborts.get(id);
        if (abort === undefined) return false;

        const job = this.jobs.get(id);
        if (job === undefined || job.status !== 'running') return false;

        abort.abort();
        return true;
    }

    public subscribe(id: string, listener: Listener): () => void {
        let set = this.subscribers.get(id);

        if (set === undefined) {
            set = new Set();
            this.subscribers.set(id, set);
        }

        set.add(listener);
        return () => set?.delete(listener);
    }

    private emit(jobId: string, event: JobEvent): void {
        const subs = this.subscribers.get(jobId);
        if (subs === undefined) return;

        for (const fn of subs) {
            try {
                fn(event);
            } catch (cause) {
                process.stderr.write(`[jobs] subscriber error: ${String(cause)}\n`);
            }
        }
    }

    private log(jobId: string, message: string): void {
        const job = this.jobs.get(jobId);
        if (job === undefined) return;

        job.logs.push(message);
        if (job.logs.length > MAX_LOG_LINES) job.logs.shift();

        this.emit(jobId, {kind: 'log', message});
    }

    private updateProgress(jobId: string): void {
        const job = this.jobs.get(jobId);
        if (job === undefined) return;

        this.emit(jobId, {
            kind: 'progress',
            done: job.progress.done,
            total: job.progress.total,
            failed: job.progress.failed,
            ...(job.progress.current !== undefined ? {current: job.progress.current} : {})
        });
    }

    private finish(jobId: string, summary: string): void {
        const job = this.jobs.get(jobId);
        if (job === undefined) return;

        job.status = 'done';
        job.finishedAt = Date.now();
        job.summary = summary;

        this.emit(jobId, {kind: 'done', summary});
        this.cleanupAfter(jobId);
    }

    private fail(jobId: string, error: string): void {
        const job = this.jobs.get(jobId);
        if (job === undefined) return;

        job.status = 'failed';
        job.finishedAt = Date.now();
        job.error = error;

        this.emit(jobId, {kind: 'failed', error});
        this.cleanupAfter(jobId);
    }

    private stop(jobId: string): void {
        const job = this.jobs.get(jobId);
        if (job === undefined) return;

        job.status = 'stopped';
        job.finishedAt = Date.now();

        this.emit(jobId, {kind: 'stopped'});
        this.cleanupAfter(jobId);
    }

    private cleanupAfter(jobId: string): void {
        this.aborts.delete(jobId);
        // Keep subscribers around briefly so an SSE response can flush the
        // terminal event before closing — they'll be removed on disconnect.
    }

    private evictHistory(): void {
        const all = [...this.jobs.values()];
        if (all.length <= MAX_HISTORY) return;

        all.sort((a, b) => a.startedAt - b.startedAt);
        const toRemove = all.slice(0, all.length - MAX_HISTORY).filter((j) => j.status !== 'running');

        for (const j of toRemove) {
            this.jobs.delete(j.id);
            this.subscribers.delete(j.id);
        }
    }

    private async execute(job: JobRecord, signal: AbortSignal): Promise<void> {
        if (job.type === 'relink') {
            await this.runRelink(job, signal);
            return;
        }

        if (job.type === 'compile') {
            await this.runCompile(job, signal);
            return;
        }

        if (job.type === 'crawl-gitea') {
            await this.runGiteaCrawl(job, signal);
            return;
        }

        if (job.type === 'crawl-devto') {
            await this.runDevtoCrawl(job);
            return;
        }

        if (job.type === 'crawl-github-stars') {
            await this.runGithubStarsCrawl(job);
            return;
        }

        if (job.type === 'crawl-code') {
            await this.runCodeCrawl(job);
            return;
        }
    }

    private collectTargets(prefix: string): string[] {
        const all = this.service.listNotes();
        return all
            .filter((n) => n.id.startsWith(prefix) && !n.id.endsWith('.compiled.md'))
            .map((n) => n.id);
    }

    private async runRelink(job: JobRecord, signal: AbortSignal): Promise<void> {
        const params = job.params as RelinkJobParams;
        const limit = params.limit !== undefined && params.limit > 0 ? params.limit : Number.POSITIVE_INFINITY;
        const targets = this.collectTargets(params.prefix);

        job.progress.total = Math.min(targets.length, limit);
        this.updateProgress(job.id);
        this.log(job.id, `${targets.length} candidates under ${params.prefix}, processing ${job.progress.total}`);

        for (const id of targets) {
            if (signal.aborted) {
                this.stop(job.id);
                return;
            }

            if (job.progress.done + job.progress.failed >= job.progress.total) break;

            job.progress.current = id;
            this.updateProgress(job.id);

            try {
                const result = await this.service.relinkNote(id, {
                    useLlm: params.useLlm === true,
                    force: params.force === true,
                    abort: signal
                });

                if (result.skipped) {
                    this.log(job.id, `○ ${id} (already linked, use force to overwrite)`);
                } else if (result.accepted.length === 0) {
                    this.log(job.id, `○ ${id} (no related found)`);
                } else {
                    this.log(job.id, `✓ ${id} → ${result.accepted.length} links`);
                }

                job.progress.done += 1;
            } catch (cause) {
                if (cause instanceof Error && cause.name === 'AbortError') {
                    this.stop(job.id);
                    return;
                }

                job.progress.failed += 1;
                this.log(job.id, `! ${id}: ${cause instanceof Error ? cause.message : String(cause)}`);
            }
        }

        this.finish(
            job.id,
            `linked ${job.progress.done}, failed ${job.progress.failed} (of ${job.progress.total})`
        );
    }

    private async runCompile(job: JobRecord, signal: AbortSignal): Promise<void> {
        const params = job.params as CompileJobParams;
        const limit = params.limit !== undefined && params.limit > 0 ? params.limit : Number.POSITIVE_INFINITY;
        const targets = this.collectTargets(params.prefix);

        job.progress.total = Math.min(targets.length, limit);
        this.updateProgress(job.id);
        this.log(job.id, `${targets.length} candidates under ${params.prefix}, processing ${job.progress.total}`);

        for (const id of targets) {
            if (signal.aborted) {
                this.stop(job.id);
                return;
            }

            if (job.progress.done + job.progress.failed >= job.progress.total) break;

            job.progress.current = id;
            this.updateProgress(job.id);

            try {
                let compiled = false;

                for await (const event of this.service.compileNote(id, {
                    force: params.force === true,
                    abort: signal
                })) {
                    if (event.kind === 'error') {
                        job.progress.failed += 1;
                        this.log(job.id, `! ${id}: ${event.message}`);
                        break;
                    }

                    if (event.kind === 'done') {
                        if (event.result !== null) {
                            job.progress.done += 1;
                            compiled = true;
                            this.log(job.id, `✓ ${id} → ${event.compiledPath ?? '?'}`);
                        } else if (event.compiledPath !== undefined) {
                            // skipped due to unchanged source_hash
                            this.log(job.id, `○ ${id} (unchanged, use force to rebuild)`);
                        } else {
                            job.progress.failed += 1;
                            this.log(job.id, `! ${id}: LLM output did not parse as JSON`);
                        }
                        break;
                    }
                }

                void compiled;
            } catch (cause) {
                if (cause instanceof Error && cause.name === 'AbortError') {
                    this.stop(job.id);
                    return;
                }

                job.progress.failed += 1;
                this.log(job.id, `! ${id}: ${cause instanceof Error ? cause.message : String(cause)}`);
            }
        }

        this.finish(
            job.id,
            `compiled ${job.progress.done}, failed ${job.progress.failed} (of ${job.progress.total})`
        );
    }

    private async runGiteaCrawl(job: JobRecord, signal: AbortSignal): Promise<void> {
        const params = job.params as CrawlGiteaJobParams;
        const crawler = new GiteaIssuesCrawler({
            baseUrl: params.baseUrl,
            owner: params.owner,
            repo: params.repo,
            project: params.project,
            ...(params.token !== undefined ? {token: params.token} : {}),
            ...(params.state !== undefined ? {state: params.state} : {}),
            ...(params.since !== undefined ? {since: params.since} : {})
        });

        this.log(job.id, `[gitea] crawling ${params.owner}/${params.repo} (state=${params.state ?? 'open'}) → project ${params.project}`);

        const report = await crawler.run({
            log: (line) => this.log(job.id, line),
            // writeNoteUnscoped goes through the service's write path
            // → fulltext + graph + semantic indices update live, so the
            // freshly-imported issues surface in search / todos / prime
            // without requiring a restart.
            write: (input) => this.service.writeNoteUnscoped(input, 'crawl-gitea'),
            tryRead: (id) => this.service.tryReadNote(id),
            // Enables Slice 5's delta-refresh: the crawler walks existing
            // notes under the target prefix and derives a `since` from
            // the max gitea_updated_at, so scheduled hourly runs stay
            // cheap.
            listNotesUnder: (prefix) => this.service.listNotes().filter((n) => n.id.startsWith(prefix)),
            signal
        });

        // Track progress from the running counter so the frontend gets
        // a final "N of N" summary. Total is only known after the crawl
        // finishes (Gitea paginates lazily), so we set both to the same
        // value at the end.
        job.progress.total = report.fetched;
        job.progress.done = report.written + report.unchanged;
        job.progress.failed = report.errors.length;
        this.updateProgress(job.id);

        if (report.errors.length > 0) {
            for (const err of report.errors) {
                this.log(job.id, `! ${err.item}: ${err.error}`);
            }
        }

        if (signal.aborted) {
            this.stop(job.id);
            return;
        }

        this.finish(
            job.id,
            `gitea: fetched ${report.fetched}, wrote ${report.written}, unchanged ${report.unchanged}, `
            + `${report.errors.length} errors in ${Math.round(report.elapsedMs / 100) / 10}s`
        );
    }

    /**
     * dev.to / github-stars / code crawlers use the `{vault, log}` context
     * pattern and write STRAIGHT THROUGH the Vault — not the service write
     * path — so, unlike crawl-gitea, they do NOT update the live indices;
     * imported notes surface after the next reindex/prime. They also take
     * no AbortSignal, so "stop" only lands once run() returns. Both are
     * accepted v1 limitations (see plan).
     */
    private async runDevtoCrawl(job: JobRecord): Promise<void> {
        const params = job.params as CrawlDevtoJobParams;
        const apiKey = (params.apiKey ?? process.env.DEVTO_API_KEY ?? '').trim();
        if (apiKey === '') {
            this.fail(job.id, 'dev.to API key missing — set DEVTO_API_KEY or provide one in the job');
            return;
        }

        const crawler = new DevToCrawler({
            apiKey,
            ...(params.perPage !== undefined ? {perPage: params.perPage} : {}),
            ...(params.bodyMax !== undefined ? {bodyMax: params.bodyMax} : {}),
            ...(params.pathPrefix !== undefined && params.pathPrefix !== '' ? {pathPrefix: params.pathPrefix} : {}),
            ...(params.downloadImages !== undefined ? {downloadImages: params.downloadImages} : {})
        });

        this.log(job.id, '[devto] crawling latest articles');
        const report = await crawler.run({
            vault: this.service.getVault(),
            log: (line) => this.log(job.id, line)
        });
        this.applyCrawlerReport(job, 'devto', report);
    }

    private async runGithubStarsCrawl(job: JobRecord): Promise<void> {
        const params = job.params as CrawlGithubStarsJobParams;
        const token = (params.token ?? process.env.GITHUB_TOKEN ?? '').trim();
        if (token === '') {
            this.fail(job.id, 'GitHub token missing — set GITHUB_TOKEN or provide one in the job');
            return;
        }

        const crawler = new GitHubStarsCrawler({
            token,
            ...(params.username !== undefined && params.username !== '' ? {username: params.username} : {}),
            ...(params.readmeMax !== undefined ? {readmeMax: params.readmeMax} : {}),
            ...(params.pathPrefix !== undefined && params.pathPrefix !== '' ? {pathPrefix: params.pathPrefix} : {})
        });

        this.log(job.id, '[github-stars] crawling starred repos');
        const report = await crawler.run({
            vault: this.service.getVault(),
            log: (line) => this.log(job.id, line)
        });
        this.applyCrawlerReport(job, 'github-stars', report);
    }

    private async runCodeCrawl(job: JobRecord): Promise<void> {
        const params = job.params as CrawlCodeJobParams;
        const repoPath = (params.repoPath ?? '').trim();
        if (repoPath === '') {
            this.fail(job.id, 'repoPath is required for the code crawler');
            return;
        }

        const crawler = new CodeCrawler({
            repoPath,
            ...(params.repoName !== undefined && params.repoName !== '' ? {repoName: params.repoName} : {}),
            ...(params.withSource !== undefined ? {withSource: params.withSource} : {})
        });

        this.log(job.id, `[code] walking ${repoPath}`);
        const report = await crawler.run({
            vault: this.service.getVault(),
            log: (line) => this.log(job.id, line)
        });

        job.progress.total = report.walked;
        job.progress.done = report.written + report.unchanged;
        job.progress.failed = report.errors.length;
        this.updateProgress(job.id);
        for (const err of report.errors) this.log(job.id, `! ${err.item}: ${err.error}`);
        this.finish(
            job.id,
            `code: walked ${report.walked}, wrote ${report.written}, unchanged ${report.unchanged}, `
            + `skipped ${report.skipped}, ${report.errors.length} errors in ${Math.round(report.elapsedMs / 100) / 10}s`
        );
    }

    /** Shared tail for the two CrawlerReport-shaped crawlers (devto, github-stars). */
    private applyCrawlerReport(job: JobRecord, label: string, report: CrawlerReport): void {
        job.progress.total = report.fetched;
        job.progress.done = report.written + report.unchanged;
        job.progress.failed = report.errors.length;
        this.updateProgress(job.id);
        for (const err of report.errors) this.log(job.id, `! ${err.item}: ${err.error}`);
        this.finish(
            job.id,
            `${label}: fetched ${report.fetched}, wrote ${report.written}, unchanged ${report.unchanged}, `
            + `${report.errors.length} errors in ${Math.round(report.elapsedMs / 100) / 10}s`
        );
    }
}