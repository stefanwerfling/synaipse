---
title: Voyage Embeddings
tags: [adr, embeddings, api]
created: 2026-06-11
---

# Voyage Embeddings

## Thema

Welcher Embedding-Provider für die semantische Suche?

## Kontext

Anforderungen: gute Qualität für Doku und Code, einfache API, langlebiger Anbieter.

## Optionen

- OpenAI `text-embedding-3-large` (3072 dim)
- Cohere `embed-v4`
- Voyage AI `voyage-3-large` / `voyage-code-3`

## Entscheidung

**Voyage AI** mit `voyage-3-large` (1024 dim). Von Anthropic für Claude-Workflows empfohlen, exzellente Performance auf Doku/Code.

## Folgen

- positiv: kompakte 1024-dim-Vektoren → kleinere Indexgröße in [[Qdrant]]
- positiv: separate `input_type` für Query vs. Document
- negativ: zusätzlicher API-Key zu verwalten
- offen: Rate-Limits beim initialen Indexing großer Vaults — siehe [[Inkrementelles Reindexing]]

## Betroffene Komponenten

- `@synaipse/vector` (VoyageEmbedder)
- [[Monorepo Structure]]