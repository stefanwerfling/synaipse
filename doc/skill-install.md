# Synaipse skill install — manual targets

The installer at `scripts/install-skill.mjs` writes the MCP config for
every assistant that natively speaks MCP. A few don't, so here's the
copy-paste boilerplate for the rest.

## Default Synaipse MCP target

The web server (`npm run web`) mounts MCP at `http://localhost:3001/mcp`.
Point any client at that URL.

For setups without the web server running, use stdio with:

```bash
node --enable-source-maps /absolute/path/to/synaipse/packages/mcp-server/dist/Index.js
```

with `SYNAIPSE_MCP_TRANSPORT=stdio` in the environment.

## Per-assistant cheatsheet

### Claude Code

Auto-installed via `npm run install-skill -- claude-code`. Configures
`~/.claude.json` with an `mcpServers.synaipse` entry. Restart Claude
Code to pick it up.

### Cursor

Auto-installed via `npm run install-skill -- cursor` (workspace) or
`--global` (user-wide). Writes `.cursor/mcp.json`. Tools become
available immediately in chat.

### Cline (VS Code extension)

Auto-installed via `npm run install-skill -- cline`. Writes to
`~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`.

### Zed AI

Auto-installed via `npm run install-skill -- zed`. Writes to
`~/.config/zed/settings.json` under `context_servers.synaipse`.

### Gemini CLI

Gemini CLI doesn't speak MCP natively yet. Workaround — wrap the stdio
MCP server in a Gemini extension stub:

```toml
# ~/.gemini/extensions/synaipse/extension.toml
name = "synaipse"
description = "Personal vault tools via MCP"
command = "node"
args = ["--enable-source-maps", "/absolute/path/to/synaipse/packages/mcp-server/dist/Index.js"]
[env]
SYNAIPSE_MCP_TRANSPORT = "stdio"
```

Re-launch the CLI and `gemini extensions list` should show synaipse.

### Codex / AGENTS.md based agents

Codex doesn't have an extension mechanism — give it awareness via an
`AGENTS.md` file in the project root:

```markdown
# AGENTS.md

You have access to a personal knowledge vault via the Synaipse MCP
server at `http://localhost:3001/mcp`.

Tools available include:
- `synaipse_search` — semantic + fulltext search over my notes
- `synaipse_read_note` / `synaipse_write_note` — read/write markdown
- `synaipse_recent` — recently modified notes
- `synaipse_related` — notes thematically related to a given id
- `synaipse_graph` — backlinks/outgoing for graph queries

Always check the vault before answering questions about personal
projects, decisions, or past work.
```

### Generic MCP client

If your client supports MCP but isn't listed:

- HTTP transport: point it at `http://localhost:3001/mcp`
- stdio transport: spawn `node /absolute/path/to/synaipse/packages/mcp-server/dist/Index.js` with `SYNAIPSE_MCP_TRANSPORT=stdio` in the env

## Verifying the install

After install, hit:

```bash
curl -s http://localhost:3001/mcp -H "Accept: application/json,text/event-stream" -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

You should get JSON back listing the Synaipse tools.