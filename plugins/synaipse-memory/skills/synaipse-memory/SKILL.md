---
name: synaipse-memory
description: Working protocol for the Synaipse long-term memory (MCP tools synaipse_*). Use when starting work on a project, before answering from past decisions, when about to record a decision, fix or insight, and when cleaning up the remember inbox.
---

# Synaipse memory

Synaipse is the user's long-term memory: a markdown vault with wikilinks, tags,
search and version history, reached through the `synaipse_*` MCP tools. The
project is set by the plugin (the folder name of this repo), so relative note
paths land in `Memory/<project>/`.

## Reading

- The session primer is already in context (plugin SessionStart hook). Call
  `synaipse_prime` with a `topic` only when the work moves to a new subject.
- Search before answering from memory: `synaipse_search` (filters `tags`,
  `since`, `pathPrefix`). A hit with `section` points at the part that matches:
  pass it to `synaipse_read_note` to read only that.
- Hits marked `supersededBy` or `expired` are outdated: answer from the
  successor, mention the old state only if it matters.
- "What changed since …": `synaipse_list` with `since` (also lists removed
  notes). One note's past: `synaipse_note_history` (with `diff`).

## Writing

Pick the lightest write that fits:

| What | Tool |
|---|---|
| One insight, gotcha or fact found in passing | `synaipse_remember` (lands in the inbox) |
| What this session did and which notes it used | `synaipse_log_session` |
| A decision, how-to, analysis worth finding again | `synaipse_write_note` (`decisions/`, `howto/`, `architecture/`, `bugs/`) |
| A change to an existing note | `synaipse_edit_note` (find/replace) or `synaipse_update_note` |

- Search first; update the existing note instead of creating a second one.
  Write results list `possibleDuplicates`: merge instead of keeping both.
- New notes: `mode: "create"`. Changing a note you read: pass its `hash` as
  `expectedHash`, so a parallel change is not overwritten.
- A note that replaces an older one gets frontmatter
  `supersedes: ["Old title"]`; time-bound facts get `valid_until`.
- Link with `[[Note Title]]`; don't copy text between notes.
- Never save secrets, tokens or personal data.

## Housekeeping

- `synaipse_consolidate_inbox` (or the `consolidate-inbox` prompt) shows which
  inbox entries are already in a note and where the others belong. Propose,
  wait for the user's approval, then merge with `synaipse_edit_note`. The user
  can also do this in the web UI (Inbox tab).
- Deleting asks the user to confirm when the client supports it; deleted notes
  stay in the version history.
