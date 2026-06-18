# MCP tools reference

Synaipse exposes the following tools over MCP (stdio). All tools return JSON.

| Tool | Purpose |
|---|---|
| [`synaipse_get_project`](#synaipse_get_project)       | Read the active project context                        |
| [`synaipse_verify_history`](#synaipse_verify_history) | Re-hash every stored object — vault integrity check    |
| [`synaipse_snapshot_list`](#synaipse_snapshot_list)   | List entries of the vault at a past commit             |
| [`synaipse_search`](#synaipse_search)                 | Search notes (fulltext / semantic / hybrid)            |
| [`synaipse_read_note`](#synaipse_read_note)           | Read a single note                                     |
| [`synaipse_write_note`](#synaipse_write_note)         | Create or overwrite a note                             |
| [`synaipse_update_note`](#synaipse_update_note)       | Partial update (content and/or frontmatter)            |
| [`synaipse_delete_note`](#synaipse_delete_note)       | Delete a note + remove from vector index               |
| [`synaipse_list_notes`](#synaipse_list_notes)         | List note metadata, optionally filtered                |
| [`synaipse_list_tags`](#synaipse_list_tags)           | Tag cloud with counts                                  |
| [`synaipse_notes_by_tag`](#synaipse_notes_by_tag)     | All notes carrying a given tag                         |
| [`synaipse_backlinks`](#synaipse_backlinks)           | Notes linking to a given note                          |
| [`synaipse_outgoing_links`](#synaipse_outgoing_links) | Wikilinks contained in a note                          |
| [`synaipse_link_note`](#synaipse_link_note)           | Append wikilinks under a section (idempotent)          |
| [`synaipse_related`](#synaipse_related)               | Related-notes ranking (semantic + links + tags)        |
| [`synaipse_suggest_links`](#synaipse_suggest_links)   | Missing-links finder — related pairs without a wikilink |
| [`synaipse_graph`](#synaipse_graph)                   | Knowledge graph (nodes + edges)                        |
| [`synaipse_recent`](#synaipse_recent)                 | Most recently modified notes                           |
| [`synaipse_prime`](#synaipse_prime)                   | Curated context bundle for the active project          |
| [`synaipse_stale`](#synaipse_stale)                   | Notes that gathered dust — knowledge decay              |
| [`synaipse_todos`](#synaipse_todos)                   | Open `- [ ]` items across the vault                    |
| [`synaipse_log_session`](#synaipse_log_session)       | Append to today's session log                          |

The canonical schema lives in [`packages/mcp-server/src/Tools.ts`](../packages/mcp-server/src/Tools.ts).

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

| Arg     | Type     | Default  | Notes                                          |
|---|---|---|---|
| `query` | string   | required |                                                |
| `mode`  | enum     | `hybrid` | `fulltext` \| `semantic` \| `hybrid`             |
| `limit` | number   | `10`     |                                                |

`semantic` and `hybrid` silently degrade to `fulltext` when `EMBEDDINGS_PROVIDER=none`.

```json
{"name": "synaipse_search", "arguments": {"query": "qdrant collection setup", "mode": "hybrid"}}
```

---

## `synaipse_read_note`

| Arg | Type   | Notes                            |
|---|---|---|
| `id` | string | Vault-relative path, e.g. `Memory/decisions/auth.md` |

---

## `synaipse_write_note`

| Arg           | Type     | Notes                                    |
|---|---|---|
| `path`        | string   | Vault-relative                           |
| `content`     | string   | Markdown body without frontmatter        |
| `frontmatter` | object?  | Optional YAML frontmatter                |

Overwrites the whole file. Use `synaipse_update_note` for partial edits.

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

## `synaipse_list_notes`

| Arg          | Type     | Default | Notes                                  |
|---|---|---|---|
| `pathPrefix` | string?  | `""`    | Filter by path prefix                  |
| `limit`      | number?  | `200`   |                                        |

Returns `{id, title, tags, mtime}` per note.

---

## `synaipse_list_tags`

No arguments. Returns `[{tag, count}, …]` sorted by count descending.

---

## `synaipse_notes_by_tag`

| Arg  | Type   |
|---|---|
| `tag` | string |

---

## `synaipse_backlinks`

| Arg  | Type   |
|---|---|
| `id` | string |

Returns the ids of notes that wikilink to this one.

---

## `synaipse_outgoing_links`

| Arg  | Type   |
|---|---|
| `id` | string |

Returns the wikilinks contained in the note (resolved + unresolved).

---

## `synaipse_link_note`

| Arg        | Type      | Default        | Notes                                       |
|---|---|---|---|
| `fromId`   | string    | required       | Source note                                 |
| `toTitles` | string[]  | required       | Becomes `[[Title]]` wikilinks               |
| `section`  | string?   | `"References"` | Heading to append under (created if absent) |

Idempotent — links that already exist are skipped.

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

No arguments. Returns `{nodes, edges}` for visualisation.

---

## `synaipse_recent`

| Arg     | Type    | Default |
|---|---|---|
| `limit` | number? | `20`    |

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

A separate `todoCount` + 3-sample `todoSample` digest is included, scoped to the same project.

**`Crawler/` exclusion** — externally-imported notes (GitHub stars, dev.to articles, etc.) are dropped from `hot`, `recent` and the TODO digest by default, because they tend to dominate (large indexes have very high backlink counts and TODOs from imported articles aren't your work). Pass `includeCrawler: true` to opt them back in. `recent_session`, `project_decision` and `pinned` are unaffected — they live under `Memory/`.

**Topic always includes Crawler/** — when `topic` is given, Crawler hits are kept regardless of `includeCrawler`. Rationale: an explicit topic query is a precise signal; silently dropping e.g. `Crawler/code/<project>/SomeFile.md` (your own source code crawled into vault form) would hide legitimate hits.

Returns:

```json
{
  "project": "synaipse",
  "todoCount": 4,
  "todoSample": [{"noteId":"…","title":"…","line":12,"text":"add metrics","done":false}],
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

## Related

- [claude-code-setup.md](claude-code-setup.md) — how to actually use these from a Claude Code session
- [vault-format.md](vault-format.md)
- [architecture.md](architecture.md)