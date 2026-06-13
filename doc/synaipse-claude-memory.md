# Synaipse als Langzeitgedächtnis für Claude Code

## Rolle

Synaipse ist mein persistenter Wissensspeicher. Alle projektrelevanten Informationen, Architekturentscheidungen, TODOs, Erkenntnisse, APIs, Fehleranalysen und Dokumentationen werden dort als Markdown-Dateien gespeichert.

Claude Code hat über einen MCP-Server Zugriff auf diese Wissensbasis. Vor jeder komplexen Aufgabe soll Claude zuerst relevante Informationen aus Synaipse suchen. Nach wichtigen Entscheidungen, neuen Erkenntnissen oder Architekturänderungen soll Claude das Wissen zurück in Synaipse schreiben.

Die Wissensbasis wird zusätzlich in einer lokalen Vektor-Datenbank indexiert, damit semantische Suche über alle Notizen möglich ist. Der MCP-Server kombiniert Volltextsuche, Wikilinks, Tags und Vektor-Suche.

Ein lokaler Vite-Webserver stellt eine Oberfläche für das Browsen, Visualisieren und Bearbeiten der Wissensbasis bereit.

## Single Source of Truth

Synaipse ist die zentrale Wissensquelle für:

- Projektwissen
- Architekturentscheidungen (ADR)
- Coding Standards
- API-Dokumentationen
- Fehleranalysen
- Meeting-Notizen
- TODOs
- Forschungsnotizen
- Wiederverwendbare Lösungsansätze

## Verhalten von Claude Code

Claude soll:

1. Vor Antworten relevante Wissenseinträge suchen.
2. Vor Implementierungen bestehende Entscheidungen prüfen.
3. Nach Abschluss einer Aufgabe neues Wissen speichern.
4. Verwandte Notizen verlinken.
5. Doppelte oder veraltete Informationen erkennen.
6. Das Wissensnetz kontinuierlich verbessern.

## Architektur

```text
Claude Code
    │
    ▼
MCP Server
    │
    ├── Synaipse Vault
    │      ├── Projects/
    │      ├── ADR/
    │      ├── APIs/
    │      ├── Research/
    │      └── Memory/
    │
    ├── Vector DB
    │      ├── ChromaDB
    │      ├── Qdrant
    │      └── LanceDB
    │
    └── Search Layer
           ├── Fulltext
           ├── Semantic Search
           ├── Backlinks
           └── Graph Queries

Vite UI
    │
    ▼
Visualisierung & Pflege
```

## Empfohlene Struktur

```text
Memory/
├── decisions/
├── architecture/
├── code-patterns/
├── libraries/
├── bugs/
├── infrastructure/
├── docker/
├── flutter/
├── typescript/
├── phpstorm-plugin/
└── lora/
```

## Beispiel für gespeichertes Wissen

```markdown
# Entscheidung

Datum: 2026-06-11

## Thema
BackendCluster eingeführt

## Grund
BackendApp wurde zu groß.

## Entscheidung
Cluster-Logik in BackendCluster ausgelagert.

## Betroffene Komponenten
- BackendApp
- ServiceManager

## Folgen
- bessere Testbarkeit
- horizontale Skalierung möglich
```

# Technische umsetzung
- Typescript
- VTS Schema (https://github.com/OpenSourcePKG/vts)
