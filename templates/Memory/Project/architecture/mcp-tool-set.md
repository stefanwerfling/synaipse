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
| `synaipse_read_note` | Note per Pfad, Titel oder Alias lesen (auch einzelne Abschnitte) |
| `synaipse_write_note` | Note erstellen/überschreiben |
| `synaipse_delete_note` | Löschen |
| `synaipse_list` | Notes nach Ordner/Tag, neueste zuerst |
| `synaipse_list_tags` | Tags mit Count |
| `synaipse_links` | Ein- und ausgehende Wikilinks einer Note |
| `synaipse_graph` | Nachbarschaft einer Note (begrenzt) |

Default-Suchstrategie: **hybrid** (Fulltext gewichtet 1.0, Semantic 1.2). Siehe [[Hybrid Search Merge]].

## Verwandt

- [[Synaipse Overview]]