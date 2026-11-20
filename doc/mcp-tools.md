# MCP tools reference

Synaipse exposes its tools over MCP (stdio or Streamable HTTP). Results are **compact JSON**.

## Protocol

- **Instructions.** The initialize result carries `instructions` with the working protocol (prime first, search before writing, lightest write, edit instead of resend, link instead of copy) and the active project folder. Clients such as Claude Code put this into the model context, so it no longer has to live in `CLAUDE.md`.
- **Annotations.** Every tool has a `title` and `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint: false`, derived from the same ACL table that drives the token scope check ([`Tools/Acl.ts`](../packages/mcp-server/src/Tools/Acl.ts)).
- **Errors.** Failures, unknown tools and invalid arguments come back as tool results with `isError: true`, so the model can correct itself. Invalid enum values (search `mode`, roadmap `status`/`owner`/`priority`, list `sort`, links `direction`) are rejected, not silently replaced. Every `limit` is an integer in `[1, 500]`.
- **Note references.** `read_note`, `links` and `graph.center` accept a vault path, the path without `.md`, a title or an alias. When nothing matches, the error names close candidates.
- **Times** are ISO timestamps plus a relative `age` (`"3d"`), not epoch milliseconds.

## Toolsets

`SYNAIPSE_MCP_TOOLSETS` selects which tool groups are registered (comma-separated, or `all`). Tools of disabled sets are neither listed nor callable.

| Toolset | Default | Tools |
|---|---|---|
| `core` | always | notes, search, list, links, graph, prime, capture |
| `roadmap` | on | `synaipse_roadmap_*` |
| `benchmark` | on | `synaipse_benchmark_*` |
| `admin` | off | `synaipse_verify_history`, `synaipse_snapshot_list` |

With `SYNAIPSE_MCP_TOOLSETS=core` the tool list costs roughly 2.6k tokens (20 tools); with the defaults about 4.5k (31 tools).

## Tools

| Tool | Purpose |
|---|---|
| [`synaipse_get_project`](#synaipse_get_project)       | Read the active project context                        |
| [`synaipse_prime`](#synaipse_prime)                   | Curated context bundle for the active project          |
| [`synaipse_search`](#synaipse_search)                 | Search notes (fulltext / semantic / hybrid)            |
| [`synaipse_read_note`](#synaipse_read_note)           | Read a note, a section of it, or a page of it          |
| [`synaipse_list`](#synaipse_list)                     | List notes by folder / tag, newest first or by title   |
| [`synaipse_list_tags`](#synaipse_list_tags)           | Tag cloud with counts                                  |
| [`synaipse_links`](#synaipse_links)                   | Incoming and outgoing links of a note                  |
| [`synaipse_graph`](#synaipse_graph)                   | Bounded wikilink neighbourhood                         |
| [`synaipse_related`](#synaipse_related)               | Related-notes ranking (semantic + links + tags)        |
| [`synaipse_suggest_links`](#synaipse_suggest_links)   | Missing-links finder — related pairs without a wikilink |
| [`synaipse_stale`](#synaipse_stale)                   | Notes that gathered dust — knowledge decay              |
| [`synaipse_todos`](#synaipse_todos)                   | Open `- [ ]` items across the vault                    |
| [`synaipse_write_note`](#synaipse_write_note)         | Create or overwrite a note                             |
| [`synaipse_update_note`](#synaipse_update_note)       | Replace body and/or patch frontmatter                  |
| `synaipse_edit_note`                                  | Find/replace inside a note body                        |
| `synaipse_write_asset`                                | Upload an image into the project's `_assets/`          |
| [`synaipse_delete_note`](#synaipse_delete_note)       | Delete a note + remove from vector index               |
| [`synaipse_link_note`](#synaipse_link_note)           | Append validated wikilinks under a section             |
| [`synaipse_log_session`](#synaipse_log_session)       | Append to today's session log                          |
| [`synaipse_remember`](#synaipse_remember)             | One-line insight capture into today's inbox            |
| [Roadmap tools](#roadmap-tools)                       | Per-project roadmap (toolset `roadmap`)                |
| `synaipse_benchmark_*`                                | Per-project benchmark log (toolset `benchmark`)        |
| [`synaipse_verify_history`](#synaipse_verify_history) | Vault integrity check (toolset `admin`)                |
| [`synaipse_snapshot_list`](#synaipse_snapshot_list)   | Vault tree at a past commit (toolset `admin`)          |

The canonical schemas live in [`packages/mcp-server/src/Tools/`](../packages/mcp-server/src/Tools/).

---

## `synaipse_get_project`

No arguments. Returns the project context configured via `SYNAIPSE_PROJECT`:

```json
{
  "project": "my-app",
  "isSet": true,
  "folder": "Memory/my-app/",
  "tag": "project/my-app"
}
```

When unset, `project` is `null`, `isSet` is `false`, and all write tools (`write_note`, `update_note`, `delete_note`, `link_note`, `log_session`) reject with a `ProjectScopeError`. Reads continue to work globally.

See [configuration.md](configuration.md#project-scope) for details.

---

## `synaipse_verify_history`

No arguments. Returns `{enabled: false}` when versioning is off, otherwise the ngit verify report:

```json
{
  "enabled": true,
  "checked": 142,
  "ok": true,
  "corrupt": []
}
```

`corrupt[]` lists every object whose stored content no longer matches its sha (`{sha, reason}`). The store is healthy when this is empty.

---

## `synaipse_snapshot_list`

| Arg  | Type    | Notes                                              |
|---|---|---|
| `sha`  | string  | 40-char commit sha                                 |
| `path` | string? | Folder inside the snapshot (e.g. `Memory/decisions/`) |

Returns `{sha, path, entries: [{name, type, sha}]}` where `type` is `file` or `dir`. Use to time-travel through the vault tree, drill into folders, or compare folder contents across two commits.

---

## `synaipse_search`

| Arg       | Type     | Default  | Notes                                                                            |
|---|---|---|---|
| `query`   | string   | required |                                                                                  |
| `mode`    | enum     | `hybrid` | `fulltext` \| `semantic` \| `hybrid`                                             |
| `limit`   | number   | `10`     |                                                                                  |
| `explain` | boolean  | `false`  | Attach per-signal `components` (score + rank per fulltext/title/semantic + demote) on each hit. |

`semantic` and `hybrid` silently degrade to `fulltext` when `EMBEDDINGS_PROVIDER=none`.

```json
{"name": "synaipse_search", "arguments": {"query": "qdrant collection setup", "mode": "hybrid"}}
```

With `explain: true` each hit additionally carries:

```json
{
  "noteId": "Memory/foo/qdrant.md",
  "score": 0.0489,
  "components": {
    "title":    {"score": 1.0, "rank": 1},
    "semantic": {"score": 0.91, "rank": 2},
    "fulltext": {"score": 11, "rank": 1},
    "demote":   0.5
  }
}
```

`rank` is the 1-indexed position in that signal's ranked list; RRF uses `1/(k+rank)` with `k=60`. `demote` is only present when `< 1` (currently triggered by `_index.md` paths and notes with > 30 wikilinks). Magnitudes across signals are **not** comparable — use rank for fair comparison, raw score only for in-signal tuning.

---

## `synaipse_read_note`

| Arg        | Type     | Default | Notes |
|---|---|---|---|
| `id`       | string   |         | Vault path, path without `.md`, title or alias |
| `section`  | string?  |         | Only the part under this heading (case-insensitive; up to the next heading of the same level; headings inside code fences are ignored) |
| `offset`   | integer? | `0`     | Start character of the (section) body |
| `maxChars` | integer? | `20000` | Max body characters |

Returns `{note: {id, title, content, frontmatter, tags, wikilinks, backlinks, hash, modified, age}}`. A cut body adds `range: {offset, end, total}` and `next: "offset: <end>"`. An unknown section lists the note's headings.

---

## `synaipse_write_note`

| Arg           | Type     | Notes                                    |
|---|---|---|
| `path`        | string   | Vault-relative; relative paths land in `Memory/<project>/` |
| `content`     | string   | Markdown body without frontmatter        |
| `frontmatter` | object?  | Optional YAML frontmatter                |

Overwrites the whole file. Returns `{id, title, hash, modified, age, warnings?}` — not the note. `warnings` names wikilinks that resolve to no note. `synaipse_update_note` and `synaipse_edit_note` return the same shape plus `changed` (did the stored file change).

---

## `synaipse_update_note`

| Arg                 | Type     | Notes                                                |
|---|---|---|
| `id`                | string   | Vault-relative                                       |
| `content`           | string?  | Optional new body                                    |
| `frontmatterPatch`  | object?  | Shallow-merged into the existing frontmatter         |

Only changed fields are touched — useful when only adjusting tags or appending text.

---

## `synaipse_delete_note`

| Arg | Type   |
|---|---|
| `id` | string |

Removes the file and the matching vector chunks.

---

## `synaipse_list`

| Arg      | Type    | Default    | Notes |
|---|---|---|---|
| `prefix` | string? | `""`       | Folder prefix, e.g. `Memory/decisions/` |
| `tag`    | string? |            | Only notes with this tag |
| `sort`   | string? | `modified` | `modified` (newest first) or `title` |
| `limit`  | integer?| `50`       | |
| `cursor` | string? |            | `nextCursor` of the previous page |

Returns `{notes: [{id, title, tags, modified, age}], total, nextCursor?}`. Replaces `list_notes`, `recent` and `notes_by_tag`.

---

## `synaipse_list_tags`

No arguments. Returns `[{tag, count}, …]` sorted by count descending.

---


## `synaipse_links`

| Arg         | Type    | Default | Notes |
|---|---|---|---|
| `id`        | string  |         | Vault path, title or alias |
| `direction` | string? | `both`  | `in`, `out` or `both` |

Returns `{id, in?: [noteId], out?: [wikilink], unresolved?: [wikilink], typed?: [{target, kind}]}`. `typed` are frontmatter `links:` (`supersedes`, `duplicates`, `relates_to`, `replies_to`). Replaces `backlinks` and `outgoing_links`.

---


## `synaipse_link_note`

| Arg        | Type      | Default        | Notes                                       |
|---|---|---|---|
| `fromId`   | string    | required       | Note to add the links to                    |
| `toTitles` | string[]  | required       | Titles, aliases or vault paths              |
| `section`  | string?   | `"References"` | Heading to append under (created if absent) |

Every target must resolve to an existing note and is stored as its canonical `[[Title]]`; one unresolvable target rejects the whole call, so no dead links form. Idempotent — links that already exist are skipped.

---

## `synaipse_related`

| Arg     | Type    | Default | Notes                              |
|---|---|---|---|
| `id`    | string  | required |                                   |
| `limit` | number? | `10`     |                                   |

Combines semantic similarity, in/out wikilinks and shared tags into a ranked list with `reason`.

---

## `synaipse_suggest_links`

| Arg          | Type     | Default | Notes                                  |
|---|---|---|---|
| `limit`      | number?  | `20`    | Max suggestions returned                |
| `minScore`   | number?  | `0.65`  | Min semantic similarity in `[0,1]`. Tag-overlap suggestions are not filtered by this. |
| `pathPrefix` | string?  | `""`    | Restrict scan to a folder              |

Finds pairs of notes that look related — either via semantic similarity (vector index) or because they share ≥2 tags — but have **no wikilink** between them in either direction. Use this to discover holes in your knowledge graph and materialise them with `synaipse_link_note`.

Returns:

```json
{
  "suggestions": [
    {
      "a": "Memory/architecture/cluster.md",
      "aTitle": "BackendCluster",
      "b": "Memory/architecture/service-manager.md",
      "bTitle": "ServiceManager",
      "score": 0.82,
      "reasons": ["semantic", "tag-overlap"],
      "sharedTags": ["architecture", "cluster"]
    }
  ],
  "count": 1
}
```

Without an embeddings provider (`EMBEDDINGS_PROVIDER=none`), only tag-overlap suggestions are returned.

---

## `synaipse_graph`

| Arg      | Type     | Default | Notes |
|---|---|---|---|
| `center` | string?  |         | Vault path, title or alias |
| `depth`  | integer? | `1`     | Hops from `center` (1–3) |
| `limit`  | integer? | `100`   | Max nodes |

Returns `{center?, depth?, nodes: [{id, title}], edges: [[from, to]], truncated?, totalNodes?}` over wikilink edges. Without `center`: the `limit` best-connected notes. Never the whole vault.

---


## `synaipse_prime`

| Arg              | Type     | Default | Notes                                                              |
|---|---|---|---|
| `limit`          | number?  | `15`    | Max entries in the context list                                    |
| `topic`          | string?  | `""`    | Optional query that adds topic-relevant notes via hybrid search    |
| `includeCrawler` | boolean? | `false` | Include `Crawler/**` notes in hot/recent/topic/todos               |

Returns a curated context bundle scoped to the active project. Each entry carries a `reason` so Claude can prioritise; pinned notes always come first.

Selection buckets, deduped and capped at `limit` — applied in this priority order:

| # | Reason             | Source                                                                                  |
|---|--------------------|-----------------------------------------------------------------------------------------|
| 1 | `pinned`           | Frontmatter `prime: true` or `pinned: true`                                             |
| 2 | `recent_session`   | Top 2 by mtime from `Memory/<project>/sessions/` (or `Memory/sessions/` if no project)  |
| 3 | `project_decision` | All from `Memory/<project>/decisions/` (or `Memory/decisions/`), newest first           |
| 4 | `topic`            | Up to 5 hybrid-search hits when `topic` is given — **prioritised above hot/recent**     |
| 5 | `hot`              | Top 3 by backlink count, project-scoped                                                 |
| 6 | `recent`           | Top 5 by mtime within the last 14 days, project-scoped                                  |

A separate `todoCount` + 3-sample `todoSample` digest is included, scoped to the same project. The response also carries `tokenEstimate`, a rough (`chars/4`) token count of the context + todoSample payload so callers can see what loading the bundle costs in Claude's context window. The `synaipse-memory` plugin's primer renderer surfaces this number in the file header.

**`Crawler/` exclusion** — externally-imported notes (GitHub stars, dev.to articles, etc.) are dropped from `hot`, `recent` and the TODO digest by default, because they tend to dominate (large indexes have very high backlink counts and TODOs from imported articles aren't your work). Pass `includeCrawler: true` to opt them back in. `recent_session`, `project_decision` and `pinned` are unaffected — they live under `Memory/`.

**Topic always includes Crawler/** — when `topic` is given, Crawler hits are kept regardless of `includeCrawler`. Rationale: an explicit topic query is a precise signal; silently dropping e.g. `Crawler/code/<project>/SomeFile.md` (your own source code crawled into vault form) would hide legitimate hits.

Returns:

```json
{
  "project": "synaipse",
  "todoCount": 4,
  "todoSample": [{"noteId":"…","title":"…","line":12,"text":"add metrics","done":false}],
  "tokenEstimate": 1820,
  "context": [
    {
      "id": "Memory/synaipse/decisions/dolt-vs-md.md",
      "title": "Dolt vs Markdown",
      "reason": "project_decision",
      "excerpt": "We keep Markdown so the vault stays Obsidian-readable…",
      "tags": ["decision"],
      "mtime": 1729000000000,
      "backlinkCount": 4
    }
  ]
}
```

Call once at session start (or after switching `SYNAIPSE_PROJECT`) to load what matters before doing other tool calls.

---

## `synaipse_stale`

| Arg             | Type     | Default | Notes                                              |
|---|---|---|---|
| `olderThanDays` | number?  | `90`    | Threshold in days                                  |
| `pathPrefix`    | string?  | `""`    | Restrict to a folder                               |
| `limit`         | number?  | `100`   |                                                    |

Finds notes that gather dust — neither written nor surfaced for `olderThanDays`. The age metric is `max(mtime, lastAccessed)` where `lastAccessed` is bumped whenever Synaipse reads the note via `read_note`, `search`, `related` or `backlinks`. Access counts are persisted in the index cache, so they survive restarts.

Returns:

```json
{
  "notes": [
    {
      "id": "Memory/research/old-idea.md",
      "title": "Old Idea",
      "tags": ["research"],
      "mtime": 1700000000000,
      "lastAccessed": 1700050000000,
      "accessCount": 2,
      "ageDays": 187
    }
  ],
  "count": 1,
  "olderThanDays": 90
}
```

Sorted by `ageDays` descending — most stale first.

---

## `synaipse_todos`

| Arg          | Type     | Default | Notes                          |
|---|---|---|---|
| `pathPrefix` | string?  | `""`    | Filter by path prefix          |
| `includeDone`| boolean? | `false` | Include `- [x]` items          |

Scans every note for Markdown todo items.

---

## `synaipse_log_session`

| Arg          | Type      | Notes                                              |
|---|---|---|
| `summary`    | string    | 1–5 sentence narrative                             |
| `references` | string[]? | Titles to wikilink under the entry                 |

Appends an `### HH:MM` block to `Memory/sessions/YYYY-MM-DD.md`. Creates the file if it does not exist.

---

## `synaipse_remember`

| Arg    | Type      | Notes                                                                                 |
|---|---|---|
| `text` | string    | 1–3 sentence insight. Trimmed; empty input rejected.                                  |
| `tags` | string[]? | Optional. Leading `#` and whitespace are stripped. Rendered inline as `#foo #bar`.    |

Appends an `### HH:MM` block to `Memory/<project>/inbox/YYYY-MM-DD.md`. Creates the file with frontmatter `{title: "Inbox YYYY-MM-DD", tags: ["inbox"]}` if it does not exist. Tags are rendered inline in the body (not added to frontmatter) so the inbox tag list stays clean as the file grows.

Use this for lightweight captures that sit between `log_session` (narrative recap of a work block) and `write_note` (curated standalone note): one-liners worth keeping but not worth a dedicated file yet.

---

## Roadmap tools

A per-project roadmap is an arbitrarily nested tree of implementation steps stored vault-natively at `Memory/<project>/_roadmap.md` — the step tree lives in the note's frontmatter (`roadmap:`), the body is an auto-rendered table + mermaid diagram. All roadmap tools scope on the **active project context** (set via the `/mcp/<project>` URL segment or the `x-synaipse-project` header) — they take no path argument. Hours and progress roll up from leaf steps to their parents; a step with an unsatisfied `dependsOn` is automatically flipped to `blocked`.

A step object: `{id, title, status, plannedHours?, actualHours?, owner?, priority?, progress?, noteLinks?, dependsOn?, acceptance?, evaluation?, children?}`. `status` is one of `backlog | planned | in_progress | ai_active | review | blocked | done | cancelled`. Ids are hierarchical strings (`"1"`, `"1.1"`, `"2.3.1"`).

### `synaipse_roadmap_get`

| Arg      | Type    | Notes                                              |
|---|---|---|
| `stepId` | string? | Return only this step and its subtree.             |

Returns the step tree, the live cursor (`active`), and a rolled-up `summary` (progress %, planned vs actual hours, done/blocked counts). Read before planning. Returns an empty roadmap if none exists.

### `synaipse_roadmap_plan`

| Arg        | Type     | Notes                                                             |
|---|---|---|
| `steps`    | object[]? | Full step tree to **replace** the roadmap (initial plan / restructure). |
| `step`     | object?  | Single step to upsert (alternative to `steps`).                   |
| `parentId` | string?  | Parent id to append the single `step` under (omit for top-level). |

Writes `Memory/<project>/_roadmap.md`. Malformed steps are dropped defensively.

### `synaipse_roadmap_update_step`

| Arg | Type | Notes |
|---|---|---|
| `stepId` | string | Required. The step to patch. |
| `status`, `title`, `plannedHours`, `actualHours`, `progress`, `owner`, `priority`, `acceptance`, `evaluation`, `dependsOn` | — | Only fields you pass change. |
| `note` | string? | Activity-log message (defaults to a summary of changed fields). |

Patches one step and appends an activity-log entry. Use `evaluation` to record your assessment / rationale / remaining-estimate ("auswerten").

### `synaipse_roadmap_set_active`

| Arg | Type | Notes |
|---|---|---|
| `stepId` | string? | Step to mark `ai_active`. Omit / empty clears the cursor. |

Sets the live "AI is working here" cursor: the step becomes `ai_active`, any previously-active step drops to `in_progress`. At most one step is active. Call when you start on a step so the UI shows a live indicator.

### `synaipse_roadmap_link_note`

| Arg | Type | Notes |
|---|---|---|
| `stepId` | string | Required. |
| `notes` | string[] | Note titles or paths — stored on the step, rendered as `[[wikilinks]]` so backlinks/graph work. |

Idempotent: already-linked notes are skipped.

---

## Removed tools

These tools were merged into `synaipse_list` and `synaipse_links` and removed on 2026-11-20. A call by the old name fails with a message naming the replacement:

| Old | Use instead |
|---|---|
| `synaipse_list_notes` | `synaipse_list` |
| `synaipse_recent` | `synaipse_list` (sorted by modified by default) |
| `synaipse_notes_by_tag` | `synaipse_list` with `tag` |
| `synaipse_backlinks` | `synaipse_links` with `direction: "in"` |
| `synaipse_outgoing_links` | `synaipse_links` with `direction: "out"` |

---

## Related

- [claude-code-setup.md](claude-code-setup.md) — how to actually use these from a Claude Code session
- [vault-format.md](vault-format.md)
- [architecture.md](architecture.md)