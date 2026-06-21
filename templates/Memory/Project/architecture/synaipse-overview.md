---
title: Synaipse Overview
tags: [architecture, overview]
---

# Synaipse Overview

Synaipse ist eine persistente Wissensbasis als Langzeitgedächtnis für Claude Code.

## Komponenten

```
Claude Code  ──stdio──▶  MCP Server  ──▶  Service  ──▶  Vault (Markdown)
                                                  └──▶  Vector Index ──▶  Qdrant
Vite UI      ──http──▶   Web API     ──▶  Service
```

- **Vault**: Obsidian-kompatibles Markdown. Konfigurierbar über `SYNAIPSE_VAULT_PATH`.
- **Vector Index**: Voyage Embeddings + Qdrant. Siehe [[Voyage Embeddings]] und [[Qdrant Setup]].
- **MCP Server**: Stdio-Server mit Tool-Sammlung für Claude. Siehe [[MCP Tool Set]].
- **Web UI**: Vite + React + Cytoscape Graph.

## Datenfluss bei Schreibvorgang

1. Claude ruft `synaipse_write_note` über MCP auf.
2. `service.writeNote` → `vault.write` (Datei + Parse + Backlink-Refresh)
3. `service.writeNote` → `vector.indexNote` (Chunks + Voyage-Embeddings + Qdrant-Upsert)

Externe Änderungen (z. B. Edit in Obsidian) werden über `chokidar` erkannt und triggern denselben Pfad.

## Verwandt

- [[Monorepo Structure]]
- [[Hybrid Search Merge]]