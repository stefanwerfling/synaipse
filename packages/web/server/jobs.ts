import {randomUUID} from 'node:crypto';
import type {SynaipseService} from '@synaipse/service';
import {GiteaIssuesCrawler, type GiteaIssueState} from '@synaipse/crawler';

/**
 * In-process job manager. Wraps the service's bulk methods (relink, compile,
 * …) into long-running jobs the frontend can launch, watch and stop. Single
 * service instance → single vault watcher → no cache race vs the CLI tools.
 *
 * State is in-memory; restarting the server loses active+history. That's fine
 * for MVP — jobs are short, restart-rare, and the writes themselves are
 * already persisted via vault commits.
 */

export type JobType = 'relink' | 'compile' | 'crawl-gitea';

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

export type JobParams = RelinkJobParams | CompileJobParams | CrawlGiteaJobParams;

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

    public startJob(type: JobType, params: JobParams): JobRecord {
        const id = randomUUID();
        const job: JobRecord = {
            id,
            type,
            params,
            status: 'running',
            progress: {done: 0, total: 0, failed: 0},
            startedAt: Date.now(),
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
}