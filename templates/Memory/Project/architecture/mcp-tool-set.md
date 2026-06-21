---
title: MCP Tool Set
tags: [architecture, mcp]
aliases: [Synaipse MCP Tools]
---

# MCP Tool Set

Werkzeuge, die der Synaipse-MCP-Server an Claude Code freigibt.

| Tool | Zweck |
|---|---|
| `synaipse_search` | Fulltext / Semantic / Hybrid |
| `synaipse_read_note` | Note per Id lesen |
| `synaipse_write_note` | Note erstellen/überschreiben |
| `synaipse_delete_note` | Permanentes Löschen |
| `synaipse_list_notes` | Notes filtern (pathPrefix) |
| `synaipse_list_tags` | Tags mit Count |
| `synaipse_notes_by_tag` | Notes pro Tag |
| `synaipse_backlinks` | Eingehende Wikilinks |
| `synaipse_outgoing_links` | Wikilinks der Note |
| `synaipse_graph` | Knoten + Kanten für Visualisierung |
| `synaipse_recent` | N zuletzt geänderte Notes |

Default-Suchstrategie: **hybrid** (Fulltext gewichtet 1.0, Semantic 1.2). Siehe [[Hybrid Search Merge]].

## Verwandt

- [[Synaipse Overview]]