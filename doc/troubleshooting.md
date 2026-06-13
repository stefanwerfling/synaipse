# Troubleshooting

A grab-bag of the most common pitfalls.

## Build & install

### `npm install` fails on a workspace

The monorepo uses npm workspaces. Always install from the repo root, never inside a `packages/*` directory.

### `npm run build` fails with `Cannot find module '@synaipse/...'`

Build order matters because the packages reference each other through TypeScript project references. Always use `npm run build` (which calls `tsc --build`) — a per-package `tsc` will not resolve the references.

```bash
npm run clean && npm run build
```

## MCP server

### Claude Code doesn't show `synaipse`

1. Did you build? Check that `packages/mcp-server/dist/Index.js` exists.
2. Run `/mcp` inside Claude Code. If it says `failed`, check the stderr in `~/.claude/logs`.
3. Verify you launched Claude Code from the repository root (so it sees `.mcp.json`).

### MCP tools return `vault path does not exist`

`SYNAIPSE_VAULT_PATH` is interpreted relative to the process cwd. When using the project-level `.mcp.json` the cwd is the repository root, so `./vault` resolves correctly. For the global MCP setup use an absolute path.

### Semantic search returns nothing even though I set `voyage`

- Did you start Qdrant? `docker ps` should show `synaipse-qdrant`.
- Did the initial indexing run? Check the server stderr at startup.
- Did you change provider after the first run? The collection's vector dimension may not match — see [Switching providers](#switching-providers) below.

## Docker / Qdrant / Ollama

### `synaipse-qdrant` keeps restarting

Most often a port conflict on `6333`/`6334`. Either stop the other process or change the ports in `docker-compose.yml`.

### Ollama model never finishes pulling

```bash
docker logs -f synaipse-ollama-init
```

The first pull of `nomic-embed-text` is ~270 MB. On slow connections it can take a few minutes.

### Switching providers

Different providers produce vectors with different dimensions. Qdrant collections are dimension-locked. The simplest reset:

```bash
npm run docker:down
rm -rf data/qdrant
npm run docker:up:<voyage|ollama>
```

The note index is rebuilt on next startup.

## Web UI

### `Address already in use :::5757`

Another process holds the port. Either kill it or change `WEB_PORT` in `.env`.

### Notes don't appear after creating them via MCP

- The MCP server publishes events to the API server (`WEB_API_PORT`, default `3001`). If you changed the port, restart both processes.
- Hard-reload the browser to drop a stale SSE connection.

## Vault

### Wikilink shows as unresolved even though the target exists

- Title mismatch (case- or whitespace-sensitive on the second resolution pass).
- Add the missing string to the target note's frontmatter `aliases:`.

### `npm run vault:init` complains the vault is not empty

By design — it never overwrites existing notes. Either delete the vault folder or seed manually.

## Reset everything

```bash
npm run docker:down
rm -rf data/qdrant data/ollama vault
npm run vault:init
npm run docker:up:<profile>
```

## Still stuck?

- Check the server stderr — both MCP and web API write structured logs.
- Open an issue with the failing command, the relevant log snippet, and your `EMBEDDINGS_PROVIDER`.