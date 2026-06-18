---
description: List captured Claude Code sessions in this project with their status.
---

Show a compact table of sessions captured by the synaipse-memory plugin.

## Steps

1. Run `ls -1t "$CLAUDE_PROJECT_DIR/.synaipse-sessions/"*.meta.json 2>/dev/null` via Bash. If empty, tell the user there are no captured sessions and stop.
2. `Read` each meta.json file.
3. Print a Markdown table sorted by `created_at` desc with columns:
   `Created (UTC) | Status | Tool calls | Edited files | Session id (short)`.
   Use the first 8 chars of `session_id`. Truncate `edited_files` to the first 3 entries plus `…` if longer.
4. End with a one-line summary: total count and how many are still `draft`.

Read-only. Do not call any MCP tools.