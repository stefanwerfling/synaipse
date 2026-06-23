<p align="left">
  <img src="assets/logo-wordmark.svg" alt="Synaipse" height="56" />
</p>

Persistent knowledge base & long-term memory for Claude Code.

Synaipse stores project knowledge (ADRs, API docs, bug analyses, code patterns, research notes) as Markdown in a configurable vault. An MCP server exposes the vault to Claude Code with full-text, wikilink, tag and (optional) semantic search. A vanilla-TS web UI lets you browse, edit and visualise the same data.

- **Obsidian-compatible** Markdown vault — open it in Obsidian alongside Claude
- **MCP first** — `.mcp.json` ships in the repo; Claude Code picks it up automatically
- **Pluggable embeddings** — `none`, `huggingface` (in-process ONNX, zero-Docker), `ollama` (local), or `voyage` (hosted)
- **Live web UI** — search, graph, backlinks; SSE-pushed updates when Claude writes

## Quickstart

```bash
cp .env.example .env             # EMBEDDINGS_PROVIDER defaults to "none"
npm install
npm run build
npm run vault:init
npm run web                      # http://localhost:5757
```

That's the zero-dependency path (fulltext only, no Docker, no sign-up). For semantic search pick a provider:

```bash
# local, free, needs Docker
npm run docker:up:ollama && npm run web

# hosted, best quality, needs VOYAGE_API_KEY in .env
npm run docker:up:voyage && npm run web
```

### Server mode (MariaDB-backed)

For multi-user / multi-instance deployments, run notes + chats out of MariaDB instead of the filesystem vault:

```bash
npm run docker:up:server                # mariadb:11.7 on port 3307
SYNAIPSE_MODE=server npm run web        # web + MCP boot against the DB
```

See the [architecture ADR](Memory/synaipse/decisions/2026-06-23-server-mode-architecture.md) for the rationale, the [server-storage smoke scripts](packages/server-storage/scripts/) for the verification shape, and the `SYNAIPSE_MARIADB_*` block in `.env.example` for the required environment variables. ngit history is silent (NoopHistory) in server mode until the async commit-worker lands.

Detailed walkthrough: [doc/getting-started.md](doc/getting-started.md).

## Documentation

| Guide | What's in it |
|---|---|
| [Getting started](doc/getting-started.md)        | Install, build, first run |
| [Configuration](doc/configuration.md)            | All env vars, all three providers |
| [Claude Code setup](doc/claude-code-setup.md)    | Wiring Synaipse into Claude Code |
| [Vault format](doc/vault-format.md)              | Frontmatter, wikilinks, tags, file layout |
| [MCP tools](doc/mcp-tools.md)                    | Reference for every MCP tool |
| [Web UI](doc/web-ui.md)                          | UI tour + HTTP API |
| [Architecture](doc/architecture.md)              | Packages, data flow, design |
| [Troubleshooting](doc/troubleshooting.md)        | When something fails |
| [Synaipse als Langzeitgedächtnis](doc/synaipse-claude-memory.md) | Original concept note (DE) |

Index: [doc/README.md](doc/README.md).

## Monorepo

| Package | Purpose |
|---|---|
| `@synaipse/core`           | Shared types, VTS schemas, NoteAdapter + ChatAdapter ports |
| `@synaipse/vault`          | Markdown I/O, frontmatter, wikilinks, tags, backlinks |
| `@synaipse/vector`         | Qdrant client + pluggable embedders (Voyage / Ollama / HuggingFace) |
| `@synaipse/server-storage` | MariaDB-backed adapters for `SYNAIPSE_MODE=server` |
| `@synaipse/service`        | Vault + vector orchestration, fulltext, hybrid merge |
| `@synaipse/mcp-server`     | MCP server (stdio + http) exposing tools to Claude Code |
| `@synaipse/web`            | Vanilla TS web UI (no React) for browsing, search, edit, graph |
| `@synaipse/crawler`        | External-source crawlers writing under `Crawler/` (first: GitHub stars) |

## Use from Claude Code

The repo ships a project-level [`.mcp.json`](.mcp.json). After `npm run build`, launch Claude Code from the repository root — the `synaipse` MCP server starts automatically over stdio and reads `.env`. See [doc/claude-code-setup.md](doc/claude-code-setup.md).

Available tools: `synaipse_get_project`, `_verify_history`, `_snapshot_list`, `_search`, `_read_note`, `_write_note`, `_update_note`, `_delete_note`, `_list_notes`, `_list_tags`, `_notes_by_tag`, `_backlinks`, `_outgoing_links`, `_link_note`, `_related`, `_suggest_links`, `_graph`, `_recent`, `_prime`, `_stale`, `_todos`, `_log_session`, `_remember`. Full reference: [doc/mcp-tools.md](doc/mcp-tools.md).

For shared multi-project vaults, set `SYNAIPSE_PROJECT=<name>` per Claude Code session — writes are then auto-scoped to `Memory/<name>/` and tagged `project/<name>`. See [doc/configuration.md](doc/configuration.md#project-scope).

## Stack

- TypeScript (ESM, strict, `exactOptionalPropertyTypes`)
- [VTS](https://github.com/OpenSourcePKG/vts) — runtime type schemas
- [Qdrant](https://qdrant.tech/) — vector DB (optional, Docker)
- Embeddings: [Voyage AI](https://www.voyageai.com/) (hosted) **or** [Ollama](https://ollama.com/) (local) **or** disabled
- [marked](https://marked.js.org/) — Markdown rendering
- [Cytoscape.js](https://js.cytoscape.org/) — graph visualization (lazy-loaded chunk)
- [MCP](https://modelcontextprotocol.io/) — Claude Code integration
- Vite — bundler

## Vault

Vault location is configurable via `SYNAIPSE_VAULT_PATH`. Format is Obsidian-compatible Markdown:

- YAML frontmatter (`---`)
- Wikilinks `[[Note Name]]` (alias `[[Note Name|label]]`, section `[[Note Name#Heading]]`)
- Tags `#tag` inline or as frontmatter list

Recommended structure inside the vault:

```
Memory/
├── decisions/
├── architecture/
├── code-patterns/
├── libraries/
├── bugs/
├── infrastructure/
├── research/
└── sessions/
```

Details: [doc/vault-format.md](doc/vault-format.md).

## Scripts

```
npm run build              tsc --build across all packages
npm test                   vitest run
npm run lint               eslint
npm run vault:init         seed vault from templates/ (substitutes Memory/Project/ with SYNAIPSE_PROJECT)
npm run mcp                start MCP server (stdio)
npm run web                start API + Vite dev server
npm run docker:up:voyage   start qdrant only
npm run docker:up:ollama   start qdrant + ollama + model pull
npm run docker:up:server   start mariadb (server-mode hot-tier)
npm run docker:down        stop all
npm run crawl:github-stars crawl your starred repos into Crawler/github/starred/
npm run crawl:devto        crawl the latest 100 dev.to articles into Crawler/devto/articles/
```