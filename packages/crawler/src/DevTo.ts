import path from 'node:path';
import type {Frontmatter} from '@synaipse/core';
import type {Crawler, CrawlerContext, CrawlerReport} from './Crawler.js';
import {
    getArticle,
    listLatestArticles,
    type DevToArticle,
    type DevToArticleListItem,
    type FetchOptions
} from './DevToApi.js';
import {downloadAsset, extractImageUrls, rewriteImageUrls} from './Assets.js';

export interface DevToOptions {
    apiKey: string;
    perPage?: number;
    bodyMax?: number;
    pathPrefix?: string;
    downloadImages?: boolean;
    fetch?: typeof fetch;
}

const DEFAULT_PATH_PREFIX = 'Crawler/devto/articles';
const DEFAULT_BODY_MAX = 3000;
const DEFAULT_PER_PAGE = 100;
const INDEX_TITLE = 'Dev.to — latest articles';

const slugify = (s: string): string => s
    .toLowerCase()
    .replaceAll(/[^a-z0-9-_.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

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

const articleTags = (article: DevToArticleListItem): string[] => {
    const tags = new Set<string>(['crawler', 'devto']);

    for (const t of article.tag_list) {
        tags.add(`tag/${slugify(t)}`);
    }

    if (article.organization) {
        tags.add(`devto-org/${slugify(article.organization.username)}`);
    }

    return [...tags];
};

const buildFrontmatter = (article: DevToArticleListItem, crawledAt: string): Frontmatter => {
    const fm: Frontmatter = {
        title: article.title,
        type: 'external',
        tags: articleTags(article),
        source: 'devto',
        articleId: article.id,
        slug: article.slug,
        url: article.url,
        canonicalUrl: article.canonical_url,
        author: article.user.username,
        publishedAt: dateOnly(article.published_at),
        readingTime: article.reading_time_minutes,
        reactions: article.public_reactions_count,
        positiveReactions: article.positive_reactions_count,
        comments: article.comments_count,
        crawledAt: crawledAt
    };

    if (article.user.name !== undefined && article.user.name.length > 0 && article.user.name !== article.user.username) {
        fm.authorName = article.user.name;
    }

    if (article.organization) {
        fm.organization = article.organization.username;
    }

    if (article.cover_image !== null) {
        fm.coverImage = article.cover_image;
    }

    if (article.edited_at !== null && article.edited_at !== undefined) {
        fm.editedAt = dateOnly(article.edited_at);
    }

    return fm;
};

const buildBody = (article: DevToArticleListItem, full: DevToArticle | null, bodyMax: number): string => {
    const lines: string[] = [];

    lines.push(`# ${article.title}`, '');

    if (article.description.length > 0) {
        lines.push(`> ${article.description}`, '');
    }

    const byline = article.user.name ?? article.user.username;
    const org = article.organization ? ` · ${article.organization.name}` : '';

    lines.push(
        `Article \`${article.id}\` by **${byline}**${org} · `
        + `Indexed in [[${INDEX_TITLE}]] · `
        + `[${article.url}](${article.url})`,
        ''
    );

    lines.push('## Stats', '');
    lines.push(`- 👍 **${article.public_reactions_count}** reactions · 💬 ${article.comments_count} comments · ⏱️ ${article.reading_time_minutes} min read`);
    lines.push(`- 📅 Published ${dateOnly(article.published_at)}`);

    if (article.tag_list.length > 0) {
        lines.push(`- 🏷️ Tags: ${article.tag_list.map((t) => `\`${t}\``).join(' · ')}`);
    }

    if (full?.body_markdown !== undefined && full.body_markdown.trim().length > 0) {
        lines.push('', '## Body', '');
        const {body, truncated} = truncate(full.body_markdown.trim(), bodyMax);
        lines.push(body);

        if (truncated) {
            lines.push('', `[Read the rest on dev.to](${article.url})`);
        }
    }

    return lines.join('\n');
};

const buildIndex = (articles: DevToArticleListItem[], crawledAt: string): {body: string; frontmatter: Frontmatter} => {
    const byTag = new Map<string, number>();

    for (const article of articles) {
        for (const tag of article.tag_list) {
            byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
        }
    }

    const sortedTags = [...byTag.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    const byReactions = [...articles].sort((a, b) => b.public_reactions_count - a.public_reactions_count);
    const byDate = [...articles].sort((a, b) => b.published_at.localeCompare(a.published_at));

    const lines: string[] = [];

    lines.push(`# ${INDEX_TITLE}`, '');
    lines.push(`${articles.length} articles crawled on ${crawledAt}.`, '');

    if (sortedTags.length > 0) {
        lines.push('## Top tags', '');
        for (const [tag, count] of sortedTags) {
            lines.push(`- \`${tag}\`: ${count}`);
        }
        lines.push('');
    }

    lines.push('## All articles — by date', '');
    for (const article of byDate) {
        const desc = article.description.length > 0 ? ` — ${article.description}` : '';
        lines.push(`- ${dateOnly(article.published_at)} · [[${article.title}]] \`#${article.id}\`${desc}`);
    }

    lines.push('', '## All articles — by reactions', '');
    for (const article of byReactions) {
        lines.push(`- 👍 ${article.public_reactions_count} · [[${article.title}]] \`#${article.id}\``);
    }

    return {
        body: lines.join('\n'),
        frontmatter: {
            title: INDEX_TITLE,
            type: 'external',
            tags: ['crawler', 'devto', 'index'],
            source: 'devto',
            crawledAt: crawledAt,
            totalArticles: articles.length
        }
    };
};

const articleFolder = (prefix: string, article: DevToArticleListItem): string => {
    return `${prefix}/${article.id}-${slugify(article.slug)}`;
};

const articlePath = (prefix: string, article: DevToArticleListItem): string => {
    return `${articleFolder(prefix, article)}/article.md`;
};

export class DevToCrawler implements Crawler {
    public readonly name = 'devto';

    public constructor(private readonly opts: DevToOptions) {}

    public async run(ctx: CrawlerContext): Promise<CrawlerReport> {
        const started = Date.now();
        const apiKey = this.opts.apiKey;
        const fetchOpts: FetchOptions = {log: ctx.log};

        if (this.opts.fetch !== undefined) {
            fetchOpts.fetch = this.opts.fetch;
        }

        const prefix = this.opts.pathPrefix ?? DEFAULT_PATH_PREFIX;
        const bodyMax = this.opts.bodyMax ?? DEFAULT_BODY_MAX;
        const perPage = this.opts.perPage ?? DEFAULT_PER_PAGE;
        const crawledAt = new Date().toISOString().slice(0, 10);

        const downloadImages = this.opts.downloadImages ?? true;
        const fetchImpl = this.opts.fetch ?? fetch;

        ctx.log(`[devto] fetching latest ${perPage} articles → ${prefix}/`);

        const articles = await listLatestArticles(apiKey, perPage, fetchOpts);

        const errors: Array<{item: string; error: string}> = [];
        let written = 0;
        let unchanged = 0;
        let imagesDownloaded = 0;
        let imagesCached = 0;
        let imageFailures = 0;

        for (const article of articles) {
            try {
                let full: DevToArticle | null = null;

                if (bodyMax > 0) {
                    full = await getArticle(apiKey, article.id, fetchOpts);
                }

                const folder = articleFolder(prefix, article);
                const folderAbs = path.join(ctx.vault.root, folder);
                const notePath = articlePath(prefix, article);
                const baseFrontmatter = buildFrontmatter(article, crawledAt);
                let body = buildBody(article, full, bodyMax);

                if (downloadImages) {
                    const urlToLocal = new Map<string, string>();
                    const urls = new Set<string>();

                    if (article.cover_image !== null) {
                        urls.add(article.cover_image);
                    }

                    for (const u of extractImageUrls(body)) {
                        urls.add(u);
                    }

                    for (const url of urls) {
                        const result = await downloadAsset(url, folderAbs, fetchImpl);

                        if (result.ok) {
                            urlToLocal.set(url, result.filename);

                            if (result.cached) {
                                imagesCached += 1;
                            } else {
                                imagesDownloaded += 1;
                            }
                        } else {
                            imageFailures += 1;
                            errors.push({item: `image ${url}`, error: result.error ?? 'unknown'});
                        }
                    }

                    if (article.cover_image !== null) {
                        const local = urlToLocal.get(article.cover_image);

                        if (local !== undefined) {
                            baseFrontmatter.coverImage = `./${local}`;
                        }
                    }

                    body = rewriteImageUrls(body, urlToLocal);
                }

                const before = ctx.vault.tryGet(notePath);
                await ctx.vault.write({path: notePath, content: body, frontmatter: baseFrontmatter}, {
                    message: `crawler(devto): article ${article.id} ${article.title}`,
                    author: {name: 'devto', email: 'crawler@synaipse.local'}
                });
                const after = ctx.vault.tryGet(notePath);

                if (before !== undefined && after !== undefined && before.hash === after.hash) {
                    unchanged += 1;
                } else {
                    written += 1;
                }
            } catch (cause) {
                errors.push({item: `#${article.id} ${article.title}`, error: String(cause)});
            }
        }

        if (downloadImages) {
            ctx.log(`[devto] images: ${imagesDownloaded} downloaded, ${imagesCached} cached, ${imageFailures} failed`);
        }

        try {
            const indexNote = buildIndex(articles, crawledAt);
            await ctx.vault.write({
                path: `${prefix}/_index.md`,
                content: indexNote.body,
                frontmatter: indexNote.frontmatter
            }, {
                message: `crawler(devto): refresh index (${articles.length} articles)`,
                author: {name: 'devto', email: 'crawler@synaipse.local'}
            });
        } catch (cause) {
            errors.push({item: '_index.md', error: String(cause)});
        }

        return {
            fetched: articles.length,
            written,
            unchanged,
            errors,
            elapsedMs: Date.now() - started
        };
    }
}