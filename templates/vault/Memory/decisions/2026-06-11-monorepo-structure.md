---
title: Monorepo Structure
tags: [adr, architecture, monorepo]
created: 2026-06-11
---

# Monorepo Structure

## Thema

Wie wird Synaipse organisiert (Single Repo, mehrere Repos, Workspaces)?

## Kontext

Mehrere klar getrennte Concerns: Vault-I/O, Vektor-Suche, MCP-Schnittstelle, Web-UI, Service-Orchestrierung. Alle teilen Typen und Schemas.

## Entscheidung

Monorepo mit **npm workspaces** und TypeScript Project References:

- `@synaipse/core` – Types + [[VTS]]-Schemas + Config
- `@synaipse/vault` – Markdown I/O
- `@synaipse/vector` – [[Qdrant]] + [[Voyage AI]]
- `@synaipse/service` – Vault/Vector-Orchestrierung
- `@synaipse/mcp-server` – MCP-Tools für Claude Code
- `@synaipse/web` – Vite + React UI

## Folgen

- positiv: gemeinsame Typen, ein Build-Graph, ein `npm install`
- positiv: klare Schichten (`mcp-server` und `web` teilen `service`)
- negativ: Bundle-Größe der Web-App enthält Cytoscape (~600 kB) — siehe [[Code Splitting Web Bundle]]

## Betroffene Komponenten

- [[Voyage Embeddings]]
- [[Qdrant Setup]]