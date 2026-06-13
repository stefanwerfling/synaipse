# Vault format

The vault is plain Markdown on disk. It is **Obsidian-compatible** — you can open it in Obsidian and everything works.

## File layout

A note is identified by its path relative to the vault root:

```
vault/
└── Memory/
    ├── decisions/
    │   └── 2026-06-11-voyage-embeddings.md
    ├── architecture/
    ├── code-patterns/
    ├── libraries/
    ├── bugs/
    ├── infrastructure/
    ├── research/
    └── sessions/
        └── 2026-06-13.md
```

The `Memory/` prefix and the sub-folders are convention, not enforced. The MCP `list_notes` and `notes_by_tag` tools work on any structure.

Recommended folders:

| Folder              | Purpose                                              |
|---|---|
| `decisions/`        | ADRs — one file per decision, dated filename         |
| `architecture/`     | High-level concept notes, diagrams, conventions      |
| `code-patterns/`    | Reusable patterns and snippets                       |
| `libraries/`        | Notes on third-party tools (VTS, Qdrant, …)          |
| `bugs/`             | Postmortems / fix recipes                            |
| `infrastructure/`   | Docker, CI, deployment                               |
| `research/`         | Open exploration, links, draft thoughts              |
| `sessions/`         | Auto-appended session logs (`synaipse_log_session`)  |

## Frontmatter

YAML between two `---` markers at the top:

```markdown
---
title: Voyage Embeddings
tags: [embeddings, decision, adr]
aliases: [Voyage AI, voyage-3-large]
created: 2026-06-11
updated: 2026-06-13
---

# Voyage Embeddings
...
```

Recognised keys:

| Key       | Type     | Effect |
|---|---|---|
| `title`   | string   | Display name; falls back to first H1 or filename. |
| `tags`    | string[] | Indexed; reachable via `synaipse_list_tags` / `_notes_by_tag`. |
| `aliases` | string[] | Extra names that wikilinks resolve to. |
| `created` | date     | Informational. |
| `updated` | date     | Informational. |

Any further keys are preserved as-is.

## Wikilinks

```markdown
See [[Voyage Embeddings]] for background.
Use [[Qdrant Setup|Qdrant]] as the vector store.
Jump to [[Voyage Embeddings#Costs]] for the pricing section.
```

Resolution order:

1. exact title match
2. alias match
3. case-insensitive title match
4. unresolved (rendered, but stays a dangling link in the graph)

Wikilinks are the source of truth for the graph (`synaipse_graph`) and backlinks (`synaipse_backlinks`).

## Tags

Two equivalent forms:

```markdown
---
tags: [architecture, mcp]
---

# Title

This is also indexed: #architecture #mcp
```

Inline `#tags` are picked up from the body. They are merged with frontmatter `tags`.

## Session logs

`synaipse_log_session` appends to `Memory/sessions/YYYY-MM-DD.md`. Each call creates an `### HH:MM` block with the narrative and the referenced wikilinks. The file is created on first call.

## Templates

Templates ship in [`templates/vault/`](../templates/vault). `npm run vault:init` seeds them into the configured vault. Add your own under `Memory/<folder>/_template.md` — they are pure Markdown, copy them when you need them.

## File naming tips

- Use kebab-case: `voyage-embeddings.md`.
- Prefix dated notes (decisions, sessions) with `YYYY-MM-DD-`.
- Don't include `#` or `[]` in filenames — they break wikilink parsing in some editors.

## Related

- [getting-started.md](getting-started.md)
- [mcp-tools.md](mcp-tools.md)
- [architecture.md](architecture.md)