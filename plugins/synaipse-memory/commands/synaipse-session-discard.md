---
description: Mark a captured Claude Code session as discarded without writing it to the vault.
---

Mark a captured session as `discarded` so it drops out of the default `/synaipse-session-list` draft view. The raw JSONL log stays on disk for auditing.

## Steps

1. Resolve the session: if the user passed a session id or filename argument, use it. Otherwise list the latest 5 `draft` sessions and ask which to discard.
2. `Read` the chosen `<id>.meta.json`. If `status` is already `promoted` or `discarded`, tell the user and stop.
3. `Write` the meta.json back with `status: "discarded"` and `discarded_at: "<UTC ISO ts>"` added; preserve all other existing fields.
4. Confirm: `Discarded session <short-id> (<created_at>). The raw JSONL log is kept at <path>.`

Do not delete the JSONL. Do not call MCP tools.