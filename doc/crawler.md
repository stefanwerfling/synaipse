# Crawler

Crawlers ingest external data into the vault under a separate top-level folder so it lives alongside — but never inside — your curated `Memory/`:

```
vault/
├── Memory/<project>/...    ← user-curated knowledge (project-scoped)
└── Crawler/                ← machine-generated knowledge
    └── <source>/...
```

Crawled notes are normal Markdown notes with frontmatter `type: external` and `source: <name>`. They are picked up by every regular search / list / graph tool. Tag them out via `tags: [-crawler]` patterns if you want to exclude them from a project view.

## Why a separate folder?

- `Memory/<project>/` is enforced for Synaipse-driven writes (`write_note`, `update_note`, …) — Claude must stay in scope
- Crawlers bypass that scope intentionally: they are global background processes, not per-project
- The split makes it trivial to delete or refresh a whole source without touching curated notes

## Built-in: GitHub stars

Crawls every repository you have starred on GitHub, writes one Markdown note per repo plus an `_index.md` overview.

### Setup

```bash
# in .env
GITHUB_TOKEN=ghp_…
# optional — defaults to the user the token belongs to
GITHUB_USERNAME=
GITHUB_CRAWL_README_MAX=3000
```

Token scopes:
- classic: `public_repo` (or empty if all your stars are public — `/users/<u>/starred` is public)
- fine-grained: a PAT with no extra repo permissions works for public stars

### Run

```bash
npm run build              # once
npm run crawl:github-stars
```

The crawler:
1. Resolves the username (skipped if `GITHUB_USERNAME` is set)
2. Pages through `/users/<u>/starred` (100/page)
3. For each repo: fetches its README (base64-decoded, truncated to `GITHUB_CRAWL_README_MAX`)
4. Writes `Crawler/github/starred/<owner>/<repo>.md`
5. Writes `Crawler/github/starred/_index.md` with by-language / by-topic / top-50-stars buckets

Re-running is idempotent: ngit's content-addressed store skips unchanged notes. Only changed repos produce new commits.

### Layout per repo note

Frontmatter:

```yaml
---
title: octocat/Hello-World
type: external
source: github-stars
url: https://github.com/octocat/Hello-World
stars: 1234
forks: 56
language: TypeScript
license: MIT
topics: [demo, example]
archived: false
fork: false
createdAt: 2020-01-01
pushedAt: 2025-06-01
crawledAt: 2026-06-14
tags: [crawler, github, language/typescript, topic/demo, topic/example]
---
```

Body: title, blockquoted description, link, stats list, truncated README.

### What you can do with it

- `synaipse_search "rust web framework" mode:semantic` → finds candidate libraries from your stars
- `synaipse_notes_by_tag language/rust` → all your Rust stars
- `synaipse_graph` → topic clusters visualised next to your own notes
- `synaipse_related "Memory/decisions/picked-tooling.md"` → which of your starred repos cover the same ground as your decision

### Cron

```cron
0 6 * * 0  cd ~/Synaipse && npm run crawl:github-stars >> /tmp/synaipse-crawler.log 2>&1
```

Weekly refresh keeps the vault current without touching your curated notes — only files that actually changed (e.g. a repo that gained stars) create new ngit commits.

## Writing your own crawler

Implement the `Crawler` interface:

```ts
import type {Crawler, CrawlerContext, CrawlerReport} from '@synaipse/crawler';

export class MyCrawler implements Crawler {
    readonly name = 'my-source';

    async run(ctx: CrawlerContext): Promise<CrawlerReport> {
        const started = Date.now();
        let written = 0;

        for (const item of fetchItems()) {
            await ctx.vault.write({
                path: `Crawler/my-source/${item.id}.md`,
                content: item.body,
                frontmatter: {type: 'external', source: 'my-source', title: item.title}
            }, {message: `crawler(my-source): ${item.id}`});
            written += 1;
        }

        return {fetched: written, written, unchanged: 0, errors: [], elapsedMs: Date.now() - started};
    }
}
```

Wire it into `packages/crawler/src/Cli.ts` (or your own runner) and you're set.