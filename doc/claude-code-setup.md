# Claude Code setup

How to wire Synaipse into Claude Code so the model uses the vault as long-term memory.

## Project-level MCP (recommended)

The repository ships [`.mcp.json`](../.mcp.json):

```json
{
  "mcpServers": {
    "synaipse": {
      "command": "node",
      "args": ["--enable-source-maps", "./packages/mcp-server/dist/Index.js"],
      "env": {}
    }
  }
}
```

Steps:

1. `npm install && npm run build` — produces `packages/mcp-server/dist/Index.js`.
2. Launch Claude Code from the repository root: `claude`.
3. On first launch Claude Code asks whether to trust the project-level MCP server. Approve `synaipse`.
4. Run `/mcp` inside Claude Code — `synaipse` should show as `connected`.

The MCP server reads configuration from `.env` next to `.mcp.json`, so `SYNAIPSE_VAULT_PATH`, `EMBEDDINGS_PROVIDER` etc. take effect.

## HTTP transport (multi-project daemon)

Run one central Synaipse HTTP server, point many projects at it. The project is resolved per request — via URL path or header.

Start the daemon:

```bash
SYNAIPSE_MCP_TRANSPORT=http SYNAIPSE_MCP_PORT=3030 npm run mcp:http
```

In each project's `.mcp.json`:

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

Or via header (single base URL):

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

Resolver priority: URL path > header > server's `SYNAIPSE_PROJECT` env > none (writes fail). See [configuration.md](configuration.md#per-request-project-http-only).

## Global MCP (alternative)

If you want the same vault available from any directory, add to `~/.claude.json` (or use `claude mcp add`):

```json
{
  "mcpServers": {
    "synaipse": {
      "command": "node",
      "args": [
        "--enable-source-maps",
        "/absolute/path/to/synaipse/packages/mcp-server/dist/Index.js"
      ],
      "env": {
        "SYNAIPSE_VAULT_PATH": "/absolute/path/to/vault",
        "EMBEDDINGS_PROVIDER": "none"
      }
    }
  }
}
```

Use absolute paths because the server inherits the launching shell's cwd.

## Prompt patterns

Give Claude a short instruction in `CLAUDE.md` so it actually reaches for the tools. A minimal version:

```markdown
You have access to a persistent knowledge base via the `synaipse_*` MCP tools.

Before answering complex questions or starting non-trivial work:
- run `synaipse_search` with the user's keywords
- if a returned hit looks relevant, `synaipse_read_note` it

After finishing meaningful work:
- store new decisions, patterns, postmortems via `synaipse_write_note`
  under `Memory/<folder>/<kebab-case-title>.md`
- link related notes via `synaipse_link_note`
- log the session via `synaipse_log_session`

Prefer `synaipse_update_note` for partial edits over `_write_note`.
```

## Verifying

In a fresh Claude Code session try:

> Was steht in Synaipse zu Voyage Embeddings?

Claude should call `synaipse_search` (and probably `synaipse_read_note`) before answering. If it does not, `/mcp` will show whether the server is connected.

## Tips

- The web UI (`npm run web`) runs alongside Claude Code without conflict — they read/write the same vault.
- If you edit notes directly in the editor, the `chokidar` watcher refreshes the in-memory index. No restart needed.
- When you switch `EMBEDDINGS_PROVIDER`, restart Claude Code so the MCP server picks up the new env.

## Related

- [mcp-tools.md](mcp-tools.md) — every tool with arguments
- [configuration.md](configuration.md) — env vars
- [troubleshooting.md](troubleshooting.md)