# Getting Started

This guide walks you through the first install and verifies that the web UI and the MCP server work.

## Requirements

- Node.js ≥ 20
- npm (bundled with Node)
- Docker + Docker Compose (only required for `ollama` or `voyage`)
- ~500 MB free disk (more if you use `ollama`)

## 1. Clone & install

```bash
git clone <your-fork> synaipse
cd synaipse
npm install
```

## 2. Configure environment

```bash
cp .env.example .env
```

Pick an embeddings provider by editing `EMBEDDINGS_PROVIDER` in `.env`:

| Provider | Docker | Sign-up | Quality | When to use |
|---|---|---|---|---|
| `none`   | no  | no  | n/a (fulltext only)        | Trying things out, lowest setup |
| `ollama` | yes | no  | good (open models)         | Local, offline, free            |
| `voyage` | yes | yes | best (`voyage-3-large`)    | Production-grade retrieval      |

For details on every variable see [configuration.md](configuration.md).

## 3. Build

```bash
npm run build
```

This runs `tsc --build` across every package. After this step the MCP server entry point exists at `packages/mcp-server/dist/Index.js`.

## 4. Seed the vault

```bash
npm run vault:init
```

Copies the template notes from `templates/vault/` into the directory pointed to by `SYNAIPSE_VAULT_PATH` (default: `./vault`). Skip the step if you already have a vault.

## 5. Start the services

### Option A — fulltext only

```bash
npm run web
```

### Option B — local embeddings (Ollama)

```bash
npm run docker:up:ollama   # starts Qdrant + Ollama, pulls nomic-embed-text
npm run web
```

The first start downloads ~270 MB. Tail it with:

```bash
docker logs -f synaipse-ollama-init
```

### Option C — hosted embeddings (Voyage)

```bash
# set VOYAGE_API_KEY in .env first
npm run docker:up:voyage   # Qdrant only
npm run web
```

## 6. Open the web UI

http://localhost:5757

You should see the templated notes from `templates/vault/`. Try the search bar in `fulltext` mode first — `semantic` and `hybrid` only return results once embeddings are indexed (provider ≠ `none`).

## 7. Verify the MCP server

The project ships a [`.mcp.json`](../.mcp.json). When you launch Claude Code from this directory, the `synaipse` MCP server is started automatically over stdio. To check manually:

```bash
npm run mcp
```

Then send an `initialize` request via your MCP client. For Claude Code-specific setup, see [claude-code-setup.md](claude-code-setup.md).

## Next steps

- [vault-format.md](vault-format.md) — frontmatter, wikilinks, tags
- [mcp-tools.md](mcp-tools.md) — every MCP tool with examples
- [troubleshooting.md](troubleshooting.md) — when something fails