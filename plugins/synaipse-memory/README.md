# synaipse-memory (Claude Code plugin)

Captures every Claude Code session in this project as a JSONL log under
`$CLAUDE_PROJECT_DIR/.synaipse-sessions/`. Curate and promote the interesting
sessions into your Synaipse vault via the bundled slash commands. **Nothing is
written to the vault automatically** — the plugin is opt-in by design.

## What gets captured

| Hook              | What it writes                                                   |
|-------------------|------------------------------------------------------------------|
| `SessionStart`    | Creates / resumes `<session_id>.jsonl` and `<session_id>.meta.json`; refreshes `.claude/synaipse-primer.md` from the Synaipse web API |
| `UserPromptSubmit`| `{kind:"user", text}` line                                       |
| `Stop`            | `{kind:"stop", transcript_path}` line                            |
| `PostToolUse`     | `Edit`/`Write`/`Bash`/`NotebookEdit` → full args + 200-char result preview. Other tools → counter line only (`{kind:"tool_counter", name, result_size}`). |
| `SessionEnd`      | Aggregates stats into the sidecar `meta.json` (`tool_call_count`, `edited_files`, `ended_at`) and appends `{kind:"session_end"}` |

A `.gitignore` is dropped into `.synaipse-sessions/` on first write so the raw
logs — which can contain secrets in tool args — never get committed.

Same `session_id` always maps to the same files, so **resume** simply appends.

## CLAUDE.md primer bridge

On every `SessionStart` (incl. resume) the hook calls `GET /api/prime?format=markdown`
on the Synaipse web API (`localhost:${SYNAIPSE_WEB_API_PORT:-3001}`) and writes the
returned bundle to `$CLAUDE_PROJECT_DIR/.claude/synaipse-primer.md`. The bundle is
the same `synaipse_prime` payload Claude would otherwise have to fetch via MCP —
pinned notes, recent sessions, project decisions, hot notes, recent edits, TODO
sample — pre-rendered as compact Markdown.

To make Claude pick the file up automatically, add one line to your
`CLAUDE.md` (project-level or user-level):

```md
@.claude/synaipse-primer.md
```

That's it — the `@`-import is resolved at session start, the primer lives in
Claude's context from the very first turn, no manual `synaipse_prime` call needed.

The file is regenerated on every SessionStart. If the web API is unreachable
(server down, wrong port, no curl), the hook silently skips the refresh and the
last known primer stays in place. Add `.claude/synaipse-primer.md` to your
`.gitignore` if you don't want to commit the snapshot — it's a derived
view of the vault, not source of truth.

Override the port with `SYNAIPSE_WEB_API_PORT=<n>` in the environment Claude
Code inherits (e.g. via your shell profile or a wrapper script).

## Slash commands

| Command                          | Purpose |
|----------------------------------|---------|
| `/synaipse-session-to-vault`     | Curate a draft session and promote it to the vault via MCP. |
| `/synaipse-session-list`         | List captured sessions with their status. |
| `/synaipse-session-discard`      | Mark a session as `discarded` without writing to the vault. |

Promotion uses one of two Synaipse MCP tools:

- `synaipse_log_session` for lightweight append-to-daily-log entries.
- `synaipse_write_note` (plus optional `synaipse_link_note`) for standalone
  notes — decisions, bug analyses, reusable patterns.

## Requirements

- `bash` (≥ 4)
- `jq` — parses the JSON hook payload; if missing, hooks `exit 0` silently
- The Synaipse MCP server registered in Claude Code (`.mcp.json` at the project
  root or in user config). Without it, capture / list / discard still work, but
  the `write` step in `session-to-vault` cannot reach the vault.

## Install (local development)

```bash
claude --plugin-dir ./plugins/synaipse-memory
```

For a permanent install, symlink or copy into `~/.claude/plugins/synaipse-memory/`.

## Files this plugin writes

```
$CLAUDE_PROJECT_DIR/
├── .synaipse-sessions/
│   ├── .gitignore                # auto-created (ignores everything inside)
│   ├── <session_id>.jsonl        # append-only event log
│   └── <session_id>.meta.json    # sidecar — status, stats, promotion target
└── .claude/
    └── synaipse-primer.md        # refreshed on each SessionStart from /api/prime
```

## Hook safety

All hooks `exit 0` even on failure, so a broken script can never block Claude
Code. Errors during capture are silent by design. To debug a hook, run it
manually with a sample stdin payload:

```bash
echo '{"session_id":"abc","cwd":"'"$PWD"'"}' \
  | bash plugins/synaipse-memory/hooks/session-start.sh
```

## Sidecar meta.json shape

```json
{
  "session_id": "…",
  "project": "…",
  "cwd": "…",
  "created_at": "2026-06-18T19:00:00Z",
  "ended_at":   "2026-06-18T20:14:00Z",
  "status": "draft | promoted | discarded",
  "tool_call_count": 42,
  "user_turns": 8,
  "assistant_turns": 9,
  "edited_files": ["src/Foo.ts", "doc/Bar.md"],
  "promoted_at": "…",
  "target": "Memory/decisions/foo.md"
}
```