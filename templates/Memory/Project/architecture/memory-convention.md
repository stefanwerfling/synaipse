---
title: Memory Convention
tags: [architecture, meta, convention]
aliases: [Synaipse Memory Convention, How to Write Notes]
---

# Memory Convention

Diese Note beschreibt, **wo** und **wie** neue Notizen in den Synaipse-Vault geschrieben werden. Sie ist die einzige Quelle der Wahrheit für die Vault-Struktur. Claude liest sie über `synaipse_read_note "Memory Convention"` bevor neue Notes angelegt werden.

## Folder-Layout

```
Memory/
├── decisions/         ADRs — datierte Entscheidungen mit Kontext und Folgen
├── architecture/      Systemüberblicke, Komponenten, Cross-Cutting-Concerns
├── code-patterns/     Wiederverwendbare TS/JS-Patterns, idiomatische Lösungen
├── libraries/         Externe Bibliotheken: API, Eigenheiten, Fallstricke
├── bugs/              Bug-Analysen mit Root-Cause und Fix-Strategie
├── infrastructure/    Docker, CI/CD, Deployment, Ports, Volumes
├── typescript/        TS-spezifische Notizen (Compiler-Flags, Tricks, Typings)
├── research/          Recherche, externe Quellen, To-Read-Listen
└── sessions/          Tagebuch-Logs (eine Datei pro Tag, [[Session Log Convention]])
```

Eine Notiz, die nicht in eines dieser Subordner passt, geht entweder in `research/` (wenn explorativ) oder ist ein Hinweis, dass ein neuer Subordner gebraucht wird — bitte vorher prüfen, ob ein bestehendes Pattern erweitert werden kann.

## Frontmatter

Jede Note hat YAML-Frontmatter mit mindestens `title` und `tags`. Optionale Felder werden angefügt, wenn sinnvoll.

```yaml
---
title: Markante, sprechende Bezeichnung   # Pflicht — wird vom Resolver für [[Wikilinks]] gematcht
tags: [pflicht-mind-eins, mehrere-ok]     # Pflicht — siehe Tag-Vokabular
aliases: [Alternative, Abkürzung]         # Optional — zusätzliche Wikilink-Targets
created: 2026-06-11                       # Optional — ISO-Datum YYYY-MM-DD
updated: 2026-06-12                       # Optional — wird vom Editor gesetzt
source: https://...                       # Optional — Quelle bei externen Inhalten
author: Name                              # Optional — Quelle/Autor
---
```

**Titel-Regeln:**
- Eindeutig im Vault (der Resolver gewinnt mit dem ersten Match)
- Title-Case bei Englisch, Satzschreibweise bei Deutsch
- Keine Sonderzeichen außer Punkt und Bindestrich
- Keine Datumsangaben im Titel (außer bei Session-Logs)

## Filename-Regeln

| Folder | Pattern | Beispiel |
|---|---|---|
| `decisions/` | `YYYY-MM-DD-slug.md` | `2026-06-11-monorepo-structure.md` |
| `sessions/` | `YYYY-MM-DD.md` | `2026-06-11.md` |
| sonst | `slug.md` (slugify vom Titel) | `synaipse-overview.md` |

Slugify: lowercase, Leerzeichen → `-`, Sonderzeichen weg, keine führenden/abschließenden `-`.

## Tag-Vokabular

Tags sind das wichtigste Filter-Werkzeug. Sparsam, aber konsistent.

**Kategorie-Tags** (genau einer pro Note):
- `adr` — datierte Entscheidung
- `architecture` — Systemstruktur
- `pattern` — wiederverwendbares Code-Pattern
- `library` — externe Abhängigkeit
- `bug` — Fehleranalyse
- `infrastructure` — Docker/CI/Deployment
- `research` — exploratives Material
- `session` — Sitzungs-Log
- `meta` — Selbst-bezogen (Konventionen, README)

**Tech-Tags** (beliebig viele):
- `typescript`, `react`, `lit`, `nodejs`, `python`
- `docker`, `postgres`, `qdrant`, `voyage`, `ollama`
- `mcp`, `embeddings`, `search`, `vector-db`
- `vts`, `tooling`

**Status-Tags** (optional):
- `wip`, `draft`, `obsolete`, `superseded-by-X`

Konvention: alle Tags **lowercase**, mit `-` als Worttrenner. Keine `#` im Frontmatter (nur in Inline-Tags im Body, wenn überhaupt).

## Wikilinks

Format: `[[Note Title]]`, optional `[[Title|Anzeige-Text]]` und `[[Title#Heading]]`.

- **Resolver** matcht zuerst gegen `title`, dann gegen `aliases`. Titel gewinnt bei Kollision.
- **Unresolved Links** (gestrichelt, grau im UI) sind okay als To-Do-Marker, sollten aber zeitnah aufgelöst werden — entweder durch Anlegen der Ziel-Note oder Entfernen des Links.
- **Im UI** klickbar (Reader-Mode und Editor-Preview), mit Hover-Vorschau aus den ersten 220 Zeichen der Ziel-Note.

## Session Log Convention

Tägliches Logfile unter `Memory/sessions/YYYY-MM-DD.md`. Wird von Claude via `synaipse_log_session` angehängt.

Format pro Eintrag:

```markdown
## HH:MM

Kurze Narrative (1–5 Sätze), was gemacht/gelernt wurde.

**References:** [[Note A]] · [[Note B]]
```

**Wann loggen:**
- Am Ende einer fokussierten Arbeitsphase (15–60 min)
- Bei einer wichtigen Entscheidung oder einem Insight
- Wenn ein Bug gefixt wurde (vorzugsweise zusätzlich eine eigene `Memory/bugs/<slug>.md`)

**Wann nicht loggen:**
- Triviale Reads ohne neue Erkenntnis
- Mehrfache schnelle Reads während Exploration (sammeln und einmal loggen)

## Wann Claude eine Note schreiben soll

- **Architektur-Entscheidung getroffen** → `Memory/decisions/YYYY-MM-DD-slug.md` mit Kontext, Optionen, Begründung, Folgen (siehe `_template.md`)
- **Bibliothek-Quirk entdeckt** → `Memory/libraries/<name>.md` mit Workaround und Verlinkung zum Issue/Doc
- **Code-Pattern wiederentdeckt** → `Memory/code-patterns/<name>.md` mit Minimal-Beispiel
- **Bug gefixt** → `Memory/bugs/<slug>.md` mit Root-Cause + Fix-Diff-Highlight, Cross-Link zur Session-Log
- **Recherchequelle gefunden** → `Memory/research/<slug>.md` oder als Library-Note mit `source:` im Frontmatter

## Wann Claude eine Note **aktualisieren** statt neu anlegen soll

- Die bestehende Note behandelt dasselbe Thema → ergänzen, mit Datum (`## Update YYYY-MM-DD`)
- Eine veraltete Entscheidung wird abgelöst → alte Note bekommt Tag `superseded-by-<slug>`, neue Note bekommt `supersedes: [[Alte Note]]` im Body

## Migration / Backwards-Kompatibilität

Wenn du beim Lesen einer alten Note merkst, dass sie die Konvention verletzt (z. B. fehlende Tags, Sonderzeichen im Titel), korrigier es **nur**, wenn du gerade aus inhaltlichen Gründen schreibst. Reine Format-Migrations gehen als eigene Pull-Action — nicht in der Mitte einer fachlichen Änderung.

## Verwandt

- [[Synaipse Overview]] — Gesamtarchitektur
- [[MCP Tool Set]] — Welche Tools Claude für Vault-Operationen hat
- [[Decision Template]] — ADR-Skelett