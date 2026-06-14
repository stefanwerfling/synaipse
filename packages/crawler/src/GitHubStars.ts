import type {Frontmatter} from '@synaipse/core';
import type {Crawler, CrawlerContext, CrawlerReport} from './Crawler.js';
import {
    getAuthenticatedUser,
    getReadme,
    listStarredRepos,
    type FetchOptions,
    type GitHubRepo
} from './GitHubApi.js';

export interface GitHubStarsOptions {
    token: string;
    username?: string;
    readmeMax?: number;
    pathPrefix?: string;
    fetch?: typeof fetch;
}

const DEFAULT_PATH_PREFIX = 'Crawler/github/starred';
const DEFAULT_README_MAX = 3000;

const slugify = (s: string): string => s
    .toLowerCase()
    .replaceAll(/[^a-z0-9-_.]+/g, '-')
    .replace(/^-+|-+$/g, '');

const truncate = (text: string, max: number): {body: string; truncated: boolean} => {
    if (text.length <= max) {
        return {body: text, truncated: false};
    }

    return {body: `${text.slice(0, max)}\n\n…(truncated)`, truncated: true};
};

const dateOnly = (iso: string | null | undefined): string => {
    if (iso === null || iso === undefined) {
        return '';
    }

    return iso.slice(0, 10);
};

const repoTags = (repo: GitHubRepo): string[] => {
    const tags = new Set<string>(['crawler', 'github']);

    if (repo.language !== null) {
        tags.add(`language/${slugify(repo.language)}`);
    }

    for (const topic of repo.topics) {
        tags.add(`topic/${slugify(topic)}`);
    }

    if (repo.archived) {
        tags.add('archived');
    }

    if (repo.fork) {
        tags.add('fork');
    }

    return [...tags];
};

const buildFrontmatter = (repo: GitHubRepo, crawledAt: string): Frontmatter => {
    const fm: Frontmatter = {
        title: repo.full_name,
        type: 'external',
        tags: repoTags(repo),
        source: 'github-stars',
        url: repo.html_url,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        openIssues: repo.open_issues_count,
        defaultBranch: repo.default_branch,
        archived: repo.archived,
        fork: repo.fork,
        createdAt: dateOnly(repo.created_at),
        pushedAt: dateOnly(repo.pushed_at),
        crawledAt: crawledAt
    };

    if (repo.description !== null && repo.description.length > 0) {
        fm.description = repo.description;
    }

    if (repo.language !== null) {
        fm.language = repo.language;
    }

    if (repo.homepage !== null && repo.homepage.length > 0) {
        fm.homepage = repo.homepage;
    }

    if (repo.license !== null && repo.license.spdx_id !== null) {
        fm.license = repo.license.spdx_id;
    }

    if (repo.topics.length > 0) {
        fm.topics = repo.topics;
    }

    return fm;
};

const buildBody = (repo: GitHubRepo, readme: string | null, readmeMax: number): string => {
    const lines: string[] = [];

    lines.push(`# ${repo.full_name}`, '');

    if (repo.description !== null) {
        lines.push(`> ${repo.description}`, '');
    }

    lines.push(`[${repo.html_url}](${repo.html_url})`, '');

    lines.push('## Stats', '');
    lines.push(`- ⭐ **${repo.stargazers_count}** stars · 🍴 ${repo.forks_count} forks · 🐛 ${repo.open_issues_count} open issues`);

    if (repo.language !== null) {
        lines.push(`- 🌐 Language: **${repo.language}**`);
    }

    if (repo.license !== null && repo.license.spdx_id !== null) {
        lines.push(`- 📦 License: ${repo.license.spdx_id}`);
    }

    if (repo.topics.length > 0) {
        lines.push(`- 🏷️ Topics: ${repo.topics.map((t) => `\`${t}\``).join(' · ')}`);
    }

    lines.push(`- 📅 Created ${dateOnly(repo.created_at)} · pushed ${dateOnly(repo.pushed_at)}`);

    if (repo.archived) {
        lines.push('- ⚠️ Archived');
    }

    if (readme !== null && readme.trim().length > 0) {
        lines.push('', '## README', '');
        const {body, truncated} = truncate(readme.trim(), readmeMax);
        lines.push(body);

        if (truncated) {
            lines.push('', `[Read the rest on GitHub](${repo.html_url}#readme)`);
        }
    }

    return lines.join('\n');
};

const buildIndex = (repos: GitHubRepo[], crawledAt: string): {body: string; frontmatter: Frontmatter} => {
    const byLanguage = new Map<string, number>();
    const byTopic = new Map<string, number>();

    for (const repo of repos) {
        const lang = repo.language ?? 'unknown';
        byLanguage.set(lang, (byLanguage.get(lang) ?? 0) + 1);

        for (const topic of repo.topics) {
            byTopic.set(topic, (byTopic.get(topic) ?? 0) + 1);
        }
    }

    const sortedLanguages = [...byLanguage.entries()].sort((a, b) => b[1] - a[1]);
    const sortedTopics = [...byTopic.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    const reposByStars = [...repos].sort((a, b) => b.stargazers_count - a.stargazers_count);

    const reposByLanguage = new Map<string, GitHubRepo[]>();
    for (const repo of reposByStars) {
        const lang = repo.language ?? 'unknown';
        const bucket = reposByLanguage.get(lang) ?? [];
        bucket.push(repo);
        reposByLanguage.set(lang, bucket);
    }

    const reposAlphabetical = [...repos].sort((a, b) => a.full_name.toLowerCase().localeCompare(b.full_name.toLowerCase()));

    const lines: string[] = [];

    lines.push('# GitHub starred repositories', '');
    lines.push(`${repos.length} repositories crawled on ${crawledAt}.`, '');

    lines.push('## By language', '');
    for (const [lang, count] of sortedLanguages) {
        lines.push(`- ${lang}: ${count}`);
    }

    if (sortedTopics.length > 0) {
        lines.push('', '## Top topics', '');
        for (const [topic, count] of sortedTopics) {
            lines.push(`- \`${topic}\`: ${count}`);
        }
    }

    lines.push('', '## All repositories — grouped by language');
    for (const [lang, count] of sortedLanguages) {
        lines.push('', `### ${lang} · ${count}`);
        const bucket = reposByLanguage.get(lang) ?? [];
        for (const repo of bucket) {
            const desc = repo.description !== null && repo.description.length > 0 ? ` — ${repo.description}` : '';
            lines.push(`- [[${repo.full_name}]] ⭐ ${repo.stargazers_count}${desc}`);
        }
    }

    lines.push('', '## All repositories — alphabetical');
    for (const repo of reposAlphabetical) {
        lines.push(`- [[${repo.full_name}]]`);
    }

    return {
        body: lines.join('\n'),
        frontmatter: {
            title: 'GitHub Starred Repos',
            type: 'external',
            tags: ['crawler', 'github', 'index'],
            source: 'github-stars',
            crawledAt: crawledAt,
            totalRepos: repos.length
        }
    };
};

const repoPath = (prefix: string, repo: GitHubRepo): string => {
    const owner = slugify(repo.owner.login);
    const name = slugify(repo.name);
    return `${prefix}/${owner}/${name}.md`;
};

export class GitHubStarsCrawler implements Crawler {
    public readonly name = 'github-stars';

    public constructor(private readonly opts: GitHubStarsOptions) {}

    public async run(ctx: CrawlerContext): Promise<CrawlerReport> {
        const started = Date.now();
        const token = this.opts.token;
        const fetchOpts: FetchOptions = {log: ctx.log};

        if (this.opts.fetch !== undefined) {
            fetchOpts.fetch = this.opts.fetch;
        }

        let username = this.opts.username;

        if (username === undefined) {
            ctx.log('[github-stars] resolving authenticated user via /user');
            const user = await getAuthenticatedUser(token, fetchOpts);
            username = user.login;
        }

        const prefix = this.opts.pathPrefix ?? DEFAULT_PATH_PREFIX;
        const readmeMax = this.opts.readmeMax ?? DEFAULT_README_MAX;
        const crawledAt = new Date().toISOString().slice(0, 10);

        ctx.log(`[github-stars] crawling stars of ${username} → ${prefix}/`);

        const repos: GitHubRepo[] = [];
        const errors: Array<{item: string; error: string}> = [];
        let written = 0;
        let unchanged = 0;

        for await (const repo of listStarredRepos(token, username, fetchOpts)) {
            repos.push(repo);

            try {
                const readme = await getReadme(token, repo.owner.login, repo.name, fetchOpts);
                const path = repoPath(prefix, repo);
                const frontmatter = buildFrontmatter(repo, crawledAt);
                const content = buildBody(repo, readme, readmeMax);

                const before = ctx.vault.tryGet(path);
                await ctx.vault.write({path, content, frontmatter}, {
                    message: `crawler(github-stars): ${repo.full_name}`,
                    author: {name: 'github-stars', email: 'crawler@synaipse.local'}
                });
                const after = ctx.vault.tryGet(path);

                if (before !== undefined && after !== undefined && before.hash === after.hash) {
                    unchanged += 1;
                } else {
                    written += 1;
                }

                if (repos.length % 25 === 0) {
                    ctx.log(`[github-stars] processed ${repos.length} repos`);
                }
            } catch (cause) {
                errors.push({item: repo.full_name, error: String(cause)});
            }
        }

        try {
            const indexNote = buildIndex(repos, crawledAt);
            await ctx.vault.write({
                path: `${prefix}/_index.md`,
                content: indexNote.body,
                frontmatter: indexNote.frontmatter
            }, {
                message: `crawler(github-stars): refresh index (${repos.length} repos)`,
                author: {name: 'github-stars', email: 'crawler@synaipse.local'}
            });
        } catch (cause) {
            errors.push({item: '_index.md', error: String(cause)});
        }

        return {
            fetched: repos.length,
            written,
            unchanged,
            errors,
            elapsedMs: Date.now() - started
        };
    }
}