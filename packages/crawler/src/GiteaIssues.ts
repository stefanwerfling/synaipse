import type {Frontmatter, Note, NoteId, NoteWriteInput} from '@synaipse/core';
import {listIssues, type FetchOptions, type GiteaIssue, type GiteaIssueState} from './GiteaApi.js';

export interface GiteaIssuesOptions {
    /** Base URL of the Gitea instance, e.g. https://gitea.example.com */
    baseUrl: string;
    owner: string;
    repo: string;
    /** Project name used in the target path + frontmatter.project. */
    project: string;
    /** Optional Personal Access Token — required only for private repos. */
    token?: string;
    /** Which issue states to pull. Default 'open'. */
    state?: GiteaIssueState;
    /** Override the default path prefix `Crawler/Gitea/<project>`. */
    pathPrefix?: string;
    /** Only fetch issues updated on/after this ISO timestamp (Gitea `since` param). */
    since?: string;
    /** Injected for tests. */
    fetch?: typeof fetch;
}

export interface GiteaCrawlerDeps {
    log: (line: string) => void;
    write: (input: NoteWriteInput) => Promise<Note>;
    tryRead: (id: NoteId) => Note | undefined;
    signal?: AbortSignal;
}

export interface GiteaCrawlerReport {
    fetched: number;
    written: number;
    unchanged: number;
    errors: Array<{item: string; error: string}>;
    elapsedMs: number;
}

const slugifyForPath = (s: string): string => s
    .toLowerCase()
    .replaceAll(/[^a-z0-9-_.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const issueTags = (issue: GiteaIssue): string[] => {
    const tags = new Set<string>(['crawler', 'gitea', 'issue', `state/${issue.state}`]);
    for (const label of issue.labels) {
        tags.add(`gitea-label/${slugifyForPath(label.name)}`);
    }
    if (issue.milestone !== null) {
        tags.add(`milestone/${slugifyForPath(issue.milestone.title)}`);
    }
    return [...tags];
};

const buildFrontmatter = (issue: GiteaIssue, project: string, crawledAt: string): Frontmatter => {
    const fm: Frontmatter = {
        title: `#${issue.number} ${issue.title}`,
        source: 'gitea',
        source_url: issue.html_url,
        project,
        tags: issueTags(issue),
        gitea_issue_number: issue.number,
        gitea_issue_state: issue.state,
        gitea_created_at: issue.created_at,
        gitea_updated_at: issue.updated_at,
        crawledAt,
        // The whole point of Slice 1+2: crawler-imported notes go
        // straight into the just-in-time consent gate. Claude may see
        // them in synaipse_todos-with-skip counts but can only *read*
        // them once the user has approved.
        mcp_consent: 'pending'
    };

    if (issue.closed_at !== null) fm.gitea_closed_at = issue.closed_at;
    if (issue.milestone !== null) fm.milestone = issue.milestone.title;
    if (issue.assignees !== null && issue.assignees.length > 0) {
        fm.assignees = issue.assignees.map((a) => a.login);
    }

    return fm;
};

const buildBody = (issue: GiteaIssue): string => {
    const lines: string[] = [];

    lines.push(`# ${issue.title}`);
    lines.push('');
    lines.push(`[Gitea #${issue.number}](${issue.html_url}) — opened by @${issue.user.login} on ${issue.created_at.slice(0, 10)}`);
    lines.push('');

    // The TODO line is the payload for synaipse_todos: consent-gated,
    // so users must approve the note before Claude sees this task in
    // its todo digest. Closed issues become `- [x]` so `includeDone`
    // determines visibility (kept out by default).
    const checkbox = issue.state === 'closed' ? '- [x]' : '- [ ]';
    lines.push(`${checkbox} ${issue.title}`);
    lines.push('');

    if (issue.body.trim().length > 0) {
        lines.push('## Description');
        lines.push('');
        lines.push(issue.body.trim());
        lines.push('');
    }

    if (issue.labels.length > 0) {
        lines.push('## Labels');
        lines.push('');
        for (const label of issue.labels) {
            lines.push(`- \`${label.name}\``);
        }
        lines.push('');
    }

    if (issue.assignees !== null && issue.assignees.length > 0) {
        lines.push('## Assignees');
        lines.push('');
        for (const a of issue.assignees) {
            lines.push(`- @${a.login}`);
        }
        lines.push('');
    }

    return lines.join('\n').trimEnd() + '\n';
};

const notePath = (prefix: string, issue: GiteaIssue): string => {
    const slug = slugifyForPath(issue.title);
    return `${prefix}/issue-${issue.number}-${slug}.md`;
};

/**
 * Crawler for Gitea issues. Writes each open (or closed, or all —
 * configurable) issue as a note under `Crawler/Gitea/<project>/`
 * with `mcp_consent: pending` so Slice 1's consent gate blocks MCP
 * reads until the user approves.
 *
 * Idempotency: existing notes are compared by their frontmatter's
 * `gitea_updated_at` field. Skipped when the remote timestamp matches
 * the last stored value — no rewrite, no commit, no consent reset.
 * When the remote issue changes we DO rewrite, but preserve any
 * existing `mcp_consent` value: users who have already approved a
 * long-lived issue don't get prompted again just because someone
 * edited the description.
 */
export class GiteaIssuesCrawler {
    public constructor(private readonly opts: GiteaIssuesOptions) {}

    public async run(deps: GiteaCrawlerDeps): Promise<GiteaCrawlerReport> {
        const started = Date.now();
        const prefix = this.opts.pathPrefix ?? `Crawler/Gitea/${slugifyForPath(this.opts.project)}`;
        const crawledAt = new Date().toISOString();

        deps.log(`[gitea] crawling ${this.opts.owner}/${this.opts.repo} → ${prefix}/`);

        const fetchOpts: FetchOptions = {log: deps.log};
        if (this.opts.token !== undefined) fetchOpts.token = this.opts.token;
        if (this.opts.fetch !== undefined) fetchOpts.fetch = this.opts.fetch;
        if (deps.signal !== undefined) fetchOpts.signal = deps.signal;

        const errors: Array<{item: string; error: string}> = [];
        let fetched = 0;
        let written = 0;
        let unchanged = 0;

        try {
            for await (const issue of listIssues(this.opts.baseUrl, this.opts.owner, this.opts.repo, {
                ...fetchOpts,
                state: this.opts.state ?? 'open',
                ...(this.opts.since !== undefined ? {since: this.opts.since} : {})
            })) {
                if (deps.signal?.aborted === true) {
                    deps.log('[gitea] aborted by caller');
                    break;
                }
                fetched++;

                try {
                    const path = notePath(prefix, issue);
                    const existing = deps.tryRead(path);
                    const existingUpdatedAt = existing?.frontmatter.gitea_updated_at;

                    if (typeof existingUpdatedAt === 'string' && existingUpdatedAt === issue.updated_at) {
                        unchanged++;
                        continue;
                    }

                    const frontmatter = buildFrontmatter(issue, this.opts.project, crawledAt);

                    // Preserve a granted/denied consent decision the user
                    // has previously made for this note. If the note is
                    // brand new or was still pending, the fresh 'pending'
                    // from buildFrontmatter stays.
                    const prevConsent = existing?.frontmatter.mcp_consent;
                    if (prevConsent === 'granted' || prevConsent === 'denied') {
                        frontmatter.mcp_consent = prevConsent;
                        const prevAt = existing?.frontmatter.mcp_consent_at;
                        if (typeof prevAt === 'string') frontmatter.mcp_consent_at = prevAt;
                    }

                    await deps.write({
                        path,
                        content: buildBody(issue),
                        frontmatter
                    });
                    written++;

                    if (fetched % 25 === 0) {
                        deps.log(`[gitea] processed ${fetched} issues (${written} written, ${unchanged} unchanged)`);
                    }
                } catch (cause) {
                    errors.push({
                        item: `issue #${issue.number}`,
                        error: cause instanceof Error ? cause.message : String(cause)
                    });
                }
            }
        } catch (cause) {
            // Top-level failure (bad base URL, auth, network). Report as
            // one aggregate error rather than throwing so JobManager can
            // still finish the record.
            errors.push({item: `${this.opts.owner}/${this.opts.repo}`, error: cause instanceof Error ? cause.message : String(cause)});
        }

        return {fetched, written, unchanged, errors, elapsedMs: Date.now() - started};
    }
}