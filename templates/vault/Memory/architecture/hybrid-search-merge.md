---
title: Hybrid Search Merge
tags: [architecture, search]
---

# Hybrid Search Merge

Im Hybrid-Modus werden Fulltext-Treffer und semantische Treffer kombiniert:

```
score(note) = sum_fulltext_hits(note) * 1.0
            + sum_semantic_hits(note) * 1.2
```

Semantic wird leicht höher gewichtet, da Voyage-Embeddings konzeptuelle Ähnlichkeit besser erfassen, während Fulltext bei exakten Begriffen unschlagbar bleibt.

## Tradeoffs

- Cold-Path: zwei parallele Calls, einer davon API-Roundtrip → ca. 100–300 ms.
- Hot-Path: nutzt Vault-In-Memory-Index + Qdrant. Niedrige Latenz.

## Verwandt

- [[MCP Tool Set]]
- [[Voyage Embeddings]]