# Architecture

A bird's-eye view of how the packages fit together.

## Components

```text
Claude Code  ──stdio──▶  @synaipse/mcp-server  ──▶  @synaipse/service  ──▶  @synaipse/vault   ──▶  Markdown files
                                                                       └─▶  @synaipse/vector  ──▶  Qdrant
                                                                                                   (Voyage | Ollama)
Web browser  ──http──▶   @synaipse/web (API)  ──▶  @synaipse/service
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
| `@synaipse/web`         | Vanilla TS UI + Node HTTP API. SSE event stream. |

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
    - `hybrid`: both, merged with rank-based fusion.
3. If `EMBEDDINGS_PROVIDER=none`, the semantic path is short-circuited and `hybrid` collapses to `fulltext`.

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
- [Cytoscape.js](https://js.cytoscape.org/) — graph view (lazy chunk)
- [chokidar](https://github.com/paulmillr/chokidar) — file watcher
- [MCP](https://modelcontextprotocol.io/) — Claude Code integration
- Vite — bundler for the web UI

## Related

- [vault-format.md](vault-format.md)
- [mcp-tools.md](mcp-tools.md)
- [configuration.md](configuration.md)