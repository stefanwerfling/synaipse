---
title: Qdrant Setup
tags: [library, vector-db, docker]
aliases: [Qdrant]
---

# Qdrant Setup

Vektor-Datenbank als Docker-Container. Image: `qdrant/qdrant:latest`.

## Ports

- `6333` HTTP/REST
- `6334` gRPC

## Collection

Bei Erststart legt `QdrantStore.ensureCollection` die Collection mit Cosine-Distanz an. Dimension wird per Embedding-Modell gemappt:

| Modell | Dimension |
|---|---|
| voyage-3-large | 1024 |
| voyage-3 | 1024 |
| voyage-3-lite | 512 |
| voyage-code-3 | 1024 |

Payload-Index auf `noteId` (Keyword) ermöglicht effizientes Löschen aller Chunks einer Note.

## Verwandt

- [[Voyage Embeddings]]
- [[Docker Compose Layout]]