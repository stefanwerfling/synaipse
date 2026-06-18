---
description: Curate a captured Claude Code session and promote it to the Synaipse vault via MCP.
---

You are about to curate a captured session log and promote it into the Synaipse vault.

## Steps

1. **Discover logs.** Run `ls -1t "$CLAUDE_PROJECT_DIR/.synaipse-sessions/"*.meta.json 2>/dev/null` via Bash to find session metadata files. `Read` each one. Skip any whose `status` is `promoted` or `discarded`. If the user passed an argument (session id or filename), use that one. Otherwise prefer the most recently created `draft` session, but list the top 3 for the user to choose if there is ambiguity.

2. **Inspect the session.** For the chosen session, `Read` both `<id>.meta.json` and `<id>.jsonl`. Form your own summary: what the user was trying to do, what got decided, what got fixed, which files were edited, which Synaipse notes were referenced via MCP.

3. **Propose.** Reply to the user with one compact proposal block:
   - **Mode** — `log_session` (lightweight, appends to today's `Memory/sessions/YYYY-MM-DD.md`) or `write_note` (standalone note — pick this when the session contains a decision, bug analysis, or reusable pattern worth its own file).
   - **Title** — only for `write_note`.
   - **Target path** — only for `write_note`, e.g. `Memory/decisions/<slug>.md`, `Memory/bugs/<slug>.md`, `Memory/code-patterns/<slug>.md`.
   - **Tags** — 3 to 6. Prefer existing tags; call `synaipse_list_tags` to see what's already in use.
   - **Summary body** — 3 to 10 sentences, Markdown. Wikilinks `[[Note Name]]` to related vault notes are welcome — use `synaipse_search` to find candidates.
   - **References** — vault note paths that came up during the session.

4. **Wait for the user's confirmation or edits.** Do not call MCP write tools before the user approves the proposal.

5. **Persist.** On approval:
   - For `log_session`: call `synaipse_log_session` with `summary` and `references`.
   - For `write_note`: call `synaipse_write_note` with the chosen `path`, frontmatter `{tags, kind: "note"}`, and the body. For each reference, call `synaipse_link_note` once.

6. **Mark the session promoted.** Update the sidecar meta.json by writing a new version of the JSON object with `status: "promoted"`, `promoted_at: "<UTC ISO ts>"`, and `target: "<written-path-or-log-tag>"` added. Use `Write` (full overwrite) on the `.meta.json` — the JSONL log stays untouched.

7. **Confirm** to the user with a one-line summary: which note was written, and which session id was marked promoted.

## Conventions

- Never call MCP write tools before the user has approved.
- If the session has fewer than 3 tool calls and contains no decisions or fixes, suggest `/synaipse-session-discard` instead.
- `synaipse_write_note` handles the `SYNAIPSE_PROJECT` path prefix automatically — do not double-prefix.