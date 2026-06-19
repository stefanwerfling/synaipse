# Configuration

All runtime configuration lives in `.env` at the repository root. Start from `.env.example`:

```bash
cp .env.example .env
```

## Vault

| Variable | Default | Purpose |
|---|---|---|
| `SYNAIPSE_VAULT_PATH`  | `./vault`                                       | Folder Synaipse reads/writes Markdown from. |
| `SYNAIPSE_INDEX_CACHE` | `<SYNAIPSE_VAULT_PATH>/.synaipse-index.json`    | Cache file for the in-memory note index. Sits inside the vault as a hidden sidecar — the walker only picks up `.md`, so it stays out of the notes list. |

The vault path is interpreted relative to the directory that the process is started from. For absolute portability use an absolute path.

## Embeddings provider

`EMBEDDINGS_PROVIDER` selects how semantic search works:

| Value          | Needs Docker | Needs API key | Notes |
|---|---|---|---|
| `none`         | no  | no  | Fulltext only. Semantic / hybrid silently fall back to fulltext. |
| `ollama`       | yes | no  | Local LLM via HTTP. Default model `nomic-embed-text`.            |
| `voyage`       | yes | yes | Hosted, fastest, highest quality.                                |
| `huggingface`  | no¹ | no  | Local in-process ONNX, no API key. Default `Xenova/all-MiniLM-L6-v2`. |

¹ Docker is still needed for Qdrant if you want persistent storage. The embedder itself runs in-process.

### `voyage`

```env
EMBEDDINGS_PROVIDER=voyage
VOYAGE_API_KEY=…
VOYAGE_MODEL=voyage-3-large
```

Get a key from [voyageai.com](https://www.voyageai.com/). `voyage-3-large` is the recommended default (1024-dim).

### `ollama`

```env
EMBEDDINGS_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=nomic-embed-text
```

The Docker profile (`docker:up:ollama`) starts an Ollama container and pulls the model on first run.

### `huggingface`

In-process ONNX inference via [`@huggingface/transformers`](https://github.com/huggingface/transformers.js) — no API key, no Ollama container, just the embedder running inside the Node process.

```env
EMBEDDINGS_PROVIDER=huggingface
HUGGINGFACE_MODEL=Xenova/all-MiniLM-L6-v2
```

Then install the optional dependency once:

```bash
npm install @huggingface/transformers
```

(It is marked `optionalDependencies` so users of `voyage`/`ollama`/`none` are not forced to pull the ~300 MB onnxruntime install.)

The first call downloads the model weights (~80 MB for MiniLM-L6) into `~/.cache/huggingface/`; subsequent calls are local and offline. The model namespace stays `Xenova/*` — that is the HF Hub account hosting the ONNX-converted weights.

Built-in dimension lookup table (see `packages/vector/src/Factory.ts`):

| Model                              | Dim  | Note                        |
|------------------------------------|------|-----------------------------|
| `Xenova/all-MiniLM-L6-v2`          | 384  | Default, English, smallest  |
| `Xenova/all-MiniLM-L12-v2`         | 384  | English, slightly stronger  |
| `Xenova/all-mpnet-base-v2`         | 768  | English, higher quality     |
| `Xenova/bge-small-en-v1.5`         | 384  | English, BGE-small          |
| `Xenova/bge-base-en-v1.5`          | 768  | English, BGE-base           |
| `Xenova/bge-large-en-v1.5`         | 1024 | English, BGE-large          |
| `Xenova/multilingual-e5-small`     | 384  | Multilingual incl. DE       |
| `Xenova/multilingual-e5-base`      | 768  | Multilingual incl. DE       |
| `Xenova/multilingual-e5-large`     | 1024 | Multilingual incl. DE       |

For other models, add the dim to `HUGGINGFACE_DIMS` and submit a PR.

## Qdrant

Required for `voyage`, `ollama` and `huggingface`. Not used for `none`.

```env
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=
QDRANT_COLLECTION=synaipse
```

The Docker profiles ship a local Qdrant on `:6333` (REST) and `:6334` (gRPC).

## MCP server

```env
MCP_SERVER_NAME=synaipse
MCP_SERVER_VERSION=0.1.0
```

These end up in the MCP server handshake metadata.

## Project scope

```env
SYNAIPSE_PROJECT=my-app
```

When set, Synaipse pins this MCP session to a single project inside the vault. Designed for shared multi-project vaults (e.g. `~/Synaipse/vault` with `Memory/app-a/`, `Memory/app-b/`, …).

Effects:

| Tool | Behaviour with `SYNAIPSE_PROJECT=my-app` |
|---|---|
| `write_note(path)`      | path is auto-prefixed to `Memory/my-app/…`. A wrong project prefix is rewritten silently. |
| writes (any kind)       | frontmatter gets `project: my-app` injected, tags get `project/my-app` (idempotent). |
| `update_note(id)`       | rejected if `id` is outside `Memory/my-app/`. |
| `delete_note(id)`       | same. |
| `link_note(fromId, …)`  | same — only the source is scoped, link targets can cross projects. |
| `log_session`           | writes into `Memory/my-app/sessions/YYYY-MM-DD.md`. |
| reads (`search`, `list_notes`, `related`, `graph`, `stale`, `todos`, …) | unchanged — Claude can still discover knowledge across projects. |

When `SYNAIPSE_PROJECT` is empty or missing, **all write tools fail** with a `ProjectScopeError` — unless the caller provides a project via HTTP (see below). Reads work as before.

### Per-request project (HTTP only)

When the MCP server runs in HTTP mode (`SYNAIPSE_MCP_TRANSPORT=http`), the project can also be supplied **per request**. Useful for one central Synaipse daemon serving many projects.

Resolver priority for each tool call:

1. URL path segment — `http://host:3030/mcp/<project>/...`
2. HTTP header — `X-Synaipse-Project: <project>`
3. Server default — `SYNAIPSE_PROJECT` env at startup

Sample `.mcp.json` variants:

```json
{
  "mcpServers": {
    "synaipse": {
      "type": "http",
      "url": "http://localhost:3030/mcp/my-app"
    }
  }
}
```

```json
{
  "mcpServers": {
    "synaipse": {
      "type": "http",
      "url": "http://localhost:3030/mcp",
      "headers": {"X-Synaipse-Project": "my-app"}
    }
  }
}
```

Project names are restricted to `[A-Za-z0-9_.-]+` to prevent path traversal.

### Per-request author and extra tags (HTTP only)

The same per-request mechanism carries two more pieces of context for multi-tenant HTTP daemons:

| Header | Maps to | Effect |
|---|---|---|
| `X-Synaipse-Author` | `Name <email>` | Used as the git commit author for every write triggered by this MCP session — different developers on the same daemon get attributed correctly |
| `X-Synaipse-Project-Tags` | comma-separated | Extra tags auto-injected on every Synaipse write, on top of `project/<name>` (e.g. `team/backend,kind/service`) |

Stdio equivalents are the ENV `SYNAIPSE_GIT_AUTHOR` (already used for the daemon-wide commit identity) and `SYNAIPSE_PROJECT_TAGS`.

Resolver priority for each tool call:

| Field | URL path | HTTP header | ENV | Default |
|---|---|---|---|---|
| project    | `/mcp/<project>` | `X-Synaipse-Project`      | `SYNAIPSE_PROJECT`       | — (writes fail) |
| gitAuthor  | —                | `X-Synaipse-Author`       | `SYNAIPSE_GIT_AUTHOR`    | `Synaipse <synaipse@local>` |
| extraTags  | —                | `X-Synaipse-Project-Tags` | `SYNAIPSE_PROJECT_TAGS`  | `[]` |

Full example for a shared HTTP daemon:

```json
{
  "mcpServers": {
    "synaipse": {
      "type": "http",
      "url": "http://localhost:3030/mcp",
      "headers": {
        "X-Synaipse-Project":      "swipemeister",
        "X-Synaipse-Author":       "Stefan Werfling <stefan@example.com>",
        "X-Synaipse-Project-Tags": "team/backend,kind/service"
      }
    }
  }
}
```

For each project, ship a `.mcp.json` in the project repository pointing at the global vault and setting its own project name:

```json
{
  "mcpServers": {
    "synaipse": {
      "command": "node",
      "args": ["/abs/path/synaipse/packages/mcp-server/dist/Index.js"],
      "env": {
        "SYNAIPSE_VAULT_PATH": "/home/me/Synaipse/vault",
        "SYNAIPSE_PROJECT": "my-app"
      }
    }
  }
}
```

Claude can query the active project at any time via `synaipse_get_project`.

## Versioning (ngit)

**Autocommit is on by default** — Synaipse versions every Synaipse-driven write to a [ngit](https://github.com/stefanwerfling/ngit) repo inside the vault. No system `git` binary required, no opt-in step. External edits (Obsidian, manual `vim`, …) are **not** autocommitted: that's the user's hand, Synaipse stays out.

```env
# both lines are optional — these are the defaults
SYNAIPSE_GIT_AUTOCOMMIT=true
SYNAIPSE_GIT_AUTHOR=Synaipse <synaipse@local>
```

The ngit on-disk layout is byte-compatible with real git's loose-object format. If you ever want a backup or want to push to GitHub:

```bash
mv vault/.ngit vault/.git
cd vault && git log
```

Disabling autocommit (`SYNAIPSE_GIT_AUTOCOMMIT=false`) stops writing new commits but the history viewer still reads any existing `.ngit/`. Commit messages follow `synaipse(<project>): <tool> <noteId>` so you can see at a glance which Synaipse tool touched each file.

### API surface

| Endpoint | Returns |
|---|---|
| `GET /api/notes/:id/history?limit=50` | `{entries: [{sha, message, author, parents}]}` |
| `GET /api/notes/:id/version/:sha`     | `{content, sha}` — note content at a past commit |
| `GET /api/notes/:id/diff?from=&to=`   | `{unified: "...diff text..."}` |
| `GET /api/snapshot/:sha?path=…`       | `{sha, path, entries: [{name, type, sha}]}` — browse the vault as it was at a past commit |
| `GET /api/snapshot/:sha/walk?prefix=…`| `{sha, prefix, count, files: [{path, sha}]}` — flat depth-first listing |
| `GET /api/health/verify`              | `{enabled: true, checked, ok, corrupt: [{sha, reason}]}` or `{enabled: false}` — re-hashes every stored object |

The web UI exposes these through:

- The **History** button in the note viewer (commit list + per-commit Diff/Snapshot tabs)
- A **Verify** button in the history panel header that runs the fsck inline

Claude can use the same endpoints via `synaipse_verify_history` and `synaipse_snapshot_list` MCP tools.

## Web UI

```env
WEB_PORT=5757
WEB_API_PORT=3001
```

`WEB_PORT` is the Vite dev server (the browser URL). `WEB_API_PORT` is the Node HTTP server that exposes `/api/*` and the SSE event stream.

## Where each variable is used

| Variable                | Used by                          |
|---|---|
| `SYNAIPSE_VAULT_PATH`   | `@synaipse/vault`, MCP server, web API |
| `SYNAIPSE_INDEX_CACHE`  | `@synaipse/service`              |
| `EMBEDDINGS_PROVIDER`   | `@synaipse/service`              |
| `VOYAGE_*`              | `@synaipse/vector`               |
| `OLLAMA_*`              | `@synaipse/vector`               |
| `HUGGINGFACE_MODEL`     | `@synaipse/vector`               |
| `QDRANT_*`              | `@synaipse/vector`               |
| `MCP_SERVER_*`          | `@synaipse/mcp-server`           |
| `WEB_PORT`, `WEB_API_PORT` | `@synaipse/web`               |

## Switching providers

If you change `EMBEDDINGS_PROVIDER`, the existing Qdrant collection may have a different vector dimension. The simplest reset:

```bash
npm run docker:down
rm -rf data/qdrant
npm run docker:up:<profile>
```

See [troubleshooting.md](troubleshooting.md) for more.