---
title: Synaipse Vault
tags: [meta]
---

# Synaipse Vault

Dieser Ordner ist der konfigurierbare Wissensspeicher von Synaipse. Pfad steuerbar über `SYNAIPSE_VAULT_PATH`.

## Struktur

```
Memory/
├── decisions/         Architektur- und Toolentscheidungen (ADR-Style)
├── architecture/      Systemüberblicke und Komponenten
├── code-patterns/     Wiederverwendbare Patterns (TS, Frontend, Backend)
├── libraries/         Externe Bibliotheken (API, Eigenheiten, Fallstricke)
├── bugs/              Bug-Analysen mit Root-Cause und Fix
├── infrastructure/    Docker, CI, Deployment
├── typescript/        TS-spezifische Notizen (Compiler-Flags, Tricks)
└── research/          Recherche und Quellen
```

## Konventionen

- **Frontmatter** mit `title`, `tags`, `aliases?`, `created?`, `updated?`.
- **Wikilinks** in der Form `[[Anderer Titel]]`. Aufgelöst über den Note-`title`.
- **Tags** entweder als Frontmatter-Array oder inline `#tag`.
- **Dateinamen** für ADRs: `YYYY-MM-DD-kurze-beschreibung.md`.

Siehe [[Decision Template]] für das ADR-Schema.