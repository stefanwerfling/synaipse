# MCP tools reference

Synaipse exposes the following tools over MCP (stdio). All tools return JSON.

| Tool | Purpose |
|---|---|
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
| [`synaipse_todos`](#synaipse_todos)                   | Open `- [ ]` items across the vault                    |
| [`synaipse_log_session`](#synaipse_log_session)       | Append to today's session log                          |

The canonical schema lives in [`packages/mcp-server/src/Tools.ts`](../packages/mcp-server/src/Tools.ts).

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