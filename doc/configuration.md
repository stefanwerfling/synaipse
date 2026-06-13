# Configuration

All runtime configuration lives in `.env` at the repository root. Start from `.env.example`:

```bash
cp .env.example .env
```

## Vault

| Variable | Default | Purpose |
|---|---|---|
| `SYNAIPSE_VAULT_PATH`  | `./vault`                    | Folder Synaipse reads/writes Markdown from. |
| `SYNAIPSE_INDEX_CACHE` | `./data/synaipse-index.json` | Cache file for the in-memory note index.    |

The vault path is interpreted relative to the directory that the process is started from. For absolute portability use an absolute path.

## Embeddings provider

`EMBEDDINGS_PROVIDER` selects how semantic search works:

| Value    | Needs Docker | Needs API key | Notes |
|---|---|---|---|
| `none`   | no  | no  | Fulltext only. Semantic / hybrid silently fall back to fulltext. |
| `ollama` | yes | no  | Local LLM, free, slower. Default model `nomic-embed-text`.       |
| `voyage` | yes | yes | Hosted, fastest, highest quality.                                 |

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

## Qdrant

Required for both `voyage` and `ollama`. Not used for `none`.

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