# Architecture

A bird's-eye view of how the packages fit together.

## Components

```text
Claude Code  ──stdio──▶  @synaipse/mcp-server  ──▶  @synaipse/service  ──▶  @synaipse/vault   ──▶  Markdown files
                                                                       └─▶  @synaipse/vector  ──▶  Qdrant
                                                                                                   (Voyage | Ollama)
Web browser  ──http──▶   @synaipse/web-api  ──▶  @synaipse/service
(@synaipse/web-client)
                          ▲
                          └─── SSE ◀── EventPublisher (MCP)
```

## Packages

| Package | Responsibility |
|---|---|
| `@synaipse/core`        | Shared types, VTS runtime schemas, `SearchMode`, `Note`, `Frontmatter` |
| `@synaipse/vault`       | Markdown I/O. Parses frontmatter, wikilinks, tags. Maintains backlinks. `chokidar`-based watcher. |
| `@synaipse/vector`      | Qdrant client; embedder abstraction with Voyage and Ollama implementations. Chunking. |
| `@synaipse/service`     | Orchestration. `writeNote`, `search` (fulltext + semantic + hybrid merge), `related`, `todos`, `appendSessionLog`, `linkNote`. |
| `@synaipse/mcp-server`  | Stdio MCP server. Tool registry in `Tools.ts`. Publishes events to the web API. |
| `@synaipse/web-api`     | Node HTTP API, SSE event stream, MCP over HTTP, serves the built UI. `embed` for hosts. |
| `@synaipse/web-client`  | Vanilla TS UI (browser only). Standalone app and the `mount()` library for hosts. Its libraries are bundled, so they are devDependencies and stay out of the server image. |

## Data flow — write

1. Claude calls `synaipse_write_note` over stdio.
2. `Tools.ts` validates arguments, delegates to `service.writeNote`.
3. `service` → `vault.write` (file written, frontmatter parsed, wikilinks extracted, backlinks refreshed).
4. `service` → `vector.indexNote` (chunked, embedded, upserted into Qdrant).
5. `EventPublisher` POSTs `{kind: "write", touched: [...]}` to the web API.
6. Web API broadcasts via SSE → connected browsers re-fetch the affected note.

## Data flow — search

1. Claude calls `synaipse_search`.
2. `service.search`:
    - `fulltext`: scans the in-memory index (title, headings, body, tags).
    - `semantic`: embeds the query, queries Qdrant, returns top-k chunks.
    - `hybrid`: title, fulltext and semantic hits merged with rank-based fusion (RRF), plus two graph signals over those candidates: `graph` (proximity to `pinned`/`prime` notes) and `context` (proximity to the last three notes read, only when one of them matches the query itself; weight 0.05, so it settles near-ties and never outweighs the text). `explain` shows each signal's rank.
3. If `EMBEDDINGS_PROVIDER=none`, the semantic path is short-circuited and `hybrid` keeps title, fulltext and the graph signals.

## External edits

`@synaipse/vault` watches the vault with `chokidar`. Edits made in Obsidian, the web UI, or any other editor go through the same parse path. The vector index is updated on debounce.

## Why these boundaries?

- **`vault` knows nothing about embeddings.** It can be used standalone for a fulltext-only setup.
- **`vector` knows nothing about Markdown.** It receives `{id, chunks}` and an embedder.
- **`service` is the only place that combines them.** It is also the single dependency of both the MCP server and the web API — they are interchangeable transports.

## Stack

- TypeScript (ESM, `strict`, `exactOptionalPropertyTypes`)
- [VTS](https://github.com/OpenSourcePKG/vts) — runtime type schemas
- [Qdrant](https://qdrant.tech/) — vector DB
- [Voyage AI](https://www.voyageai.com/) / [Ollama](https://ollama.com/) — embeddings
- [marked](https://marked.js.org/) — Markdown rendering in the UI
- [jsNGraph](https://github.com/stefanwerfling/jsNGraph) — 2D graph view and local graph (lazy chunk)
- [chokidar](https://github.com/paulmillr/chokidar) — file watcher
- [MCP](https://modelcontextprotocol.io/) — Claude Code integration
- Vite — bundler for the web UI

## Related

- [vault-format.md](vault-format.md)
- [mcp-tools.md](mcp-tools.md)
- [configuration.md](configuration.md)