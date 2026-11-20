# Synaipse — Verbesserungs- und Modernisierungsplan

> Stand: 2026-11-18 · Basis: Code-Audit über alle Packages (`core`, `vault`, `vector`, `service`,
> `server-storage`, `crawler`, `mcp-server`, `web`), das Plugin `plugins/synaipse-memory`,
> die Einbindung in **PKG Studio** (`../pkg/pkgstudio`) und die Lib **jsNGraph** (`../jsNGraph`).
> Alle Pfade sind relativ zum Repo-Root. Zeilenangaben zeigen den Stand des Audits.

---

## 0. Ziel und Leitplanken

**Ziel:** Synaipse vom gewachsenen Feature-Prototyp zu einem professionellen Produkt machen:
schnell auch bei 50k+ Notes, für LLMs sparsam und präzise nutzbar, für Menschen konsistent und
barrierearm, und als **sauberer, austauschbarer Baustein von PKG Studio** gebaut.

**Leitplanken (bleiben bestehen):**

- Der Markdown-Vault ist die Quelle der Wahrheit. Kuratieren statt Auto-Dump; die Entscheidungen aus
  dem Backlog unter „Bewusst verworfen“ gelten weiter.
- Web-UI bleibt **Vanilla TS** (kein React/TSX, kein schweres Framework).
- Dateien und Ordner unter `src/` werden in PascalCase benannt.
- `service` bleibt die einzige Stelle, die Vault und Vector kombiniert. MCP und HTTP bleiben austauschbare Transporte.
- Grafik und Visualisierung kommen bevorzugt aus der **eigenen Lib jsNGraph**. Fehlt dort etwas,
  wird es *in jsNGraph* gebaut, nicht als weitere Fremd-Dependency in Synaipse.

---

## 1. Ist-Zustand in Zahlen

| Bereich | Befund |
|---|---|
| Codebasis | ca. 50k LOC TS. `web` ca. 30k, `service` ca. 7.8k (davon `Service.ts` **3195 Zeilen**) |
| God-Files | `Styles.css` 7805 · `CanvasRenderer.ts` 2050 · `NotesPanel.ts` 1795 · `Graph3D.ts` 1702 · `routes.ts` 1446 · `BenchmarksPanel.ts` 1070 · `App.ts` 960 |
| Bundle | Initialer Entry **639 KB** (hljs, marked, turndown, jszip, CardEditor eager). Lazy: Graph3D 1.48 MB, @antv 808 KB, cytoscape 455 KB |
| MCP | **36 Tools** in einer Datei (`Tools.ts`). Tool-Liste kostet ca. **6k Tokens** pro Session. Keine `instructions`, keine Annotations, kein `structuredContent` |
| MCP SDK | Deklariert `^1.0.4`, installiert 1.29. Low-level `Server` mit handgeschriebenen Schemas |
| Tests | 85 Testdateien. **Ohne Tests:** `routes.ts`, `jobs.ts`, `Watcher.ts`, `Communities.ts`, `Layout.ts`, Embedder |
| Doku | `doc/architecture.md` veraltet (nennt Cytoscape als Graph-View, Ollama, „stdio only“). `doc/mcp-tools.md` listet 23 von 36 Tools |
| PKG Studio | Einbindung funktioniert, aber per Sonderfall (`mod.id === 'synaipse'`). Kein `unmount`, CSS-Leaks, `/api` hartkodiert |
| jsNGraph | Wird von Synaipse und PKG Studio **nicht** genutzt (nur von nornen per kopiertem IIFE). Kann heute keinen Wissensgraphen > ca. 500 Knoten |

---

## 2. Phase 0: Korrektheit zuerst (Bugs aus dem Audit, verifiziert)

Diese Punkte sind **echte Fehler**, keine Verbesserungen, und kommen vor allem anderen. Jeder Punkt ist ein eigener kleiner Commit mit Regressionstest.

| # | Bug | Ort | Fix |
|---|---|---|---|
| B1 | Der Hash-Cache gilt als „embedded“, *bevor* tatsächlich embedded wurde. Fällt der Embedder aus, wird die Note nie nachindiziert | `packages/vault/src/FilesystemNoteAdapter.ts:50` vs. `Service.ts:1547` | Separates `embeddedHash` (plus `embedModel`). Erst nach erfolgreichem Upsert setzen |
| B2 | Der Server-Mode (MariaDB) reindiziert nie. `entries.hash` ist gleich `note.hash` | `server-storage/src/MariaDBNoteAdapter.ts:147-156`, `Service.ts:494` | Spalten `embedded_hash` und `embed_model` per Migration hinzufügen |
| B3 | **Backlinks im MariaDB-Mode immer leer.** Die Map ist nach Wikilink-*Titel* gekeyt, wird aber per *Pfad-ID* gelesen. Folge: Decay hält verlinkte Notes für Waisen und könnte sie archivieren | `MariaDBNoteAdapter.ts:450` vs. `:261/:419` | Titel und Alias wie `Vault.rebuildBacklinks` zur ID auflösen. **Einen** gemeinsamen Parser statt duplizierter Regexe. Test `mariadb-note-adapter.test.ts:48` korrigieren |
| B4 | Re-Embedding ist nicht atomar: erst `delete`, dann embed. Bricht das ab, hat die Note keine Vektoren mehr | `vector/src/Pipeline.ts:94` | Erst upserten, danach überzählige Chunk-IDs löschen. `recordEntry` pro Batch |
| B5 | Embedding-Modell und Dimension der Collection werden nicht geprüft. Ein Modellwechsel vermischt Vektorräume | `vector/src/Qdrant.ts:184-205` | Modell und Dimension in Collection-Metadaten ablegen, bei Mismatch laut abbrechen oder eine neue Collection anlegen |
| B6 | ACL: `synaipse_link_note` hat `pathArg: 'source'`, das Feld heißt aber `fromId`. Der Pfad-Scope wird nie geprüft | `mcp-server/src/Tools.ts:229` | `pathArg: 'fromId'` setzen, dazu einen Test, der jeden `pathArg` gegen das Schema prüft |
| B7 | ACL: Listen- und Such-Tools (`search`, `list_notes`, `recent`, `graph`, `todos`, `prime`, `stale`, `suggest_links`) ignorieren Pfad-Präfix-Scopes | `mcp-server/src/Auth.ts:186` | Scope-Filter zentral auf die Ergebnisse anwenden (Post-Filter im Handler-Wrapper) |
| B8 | Consent-Bypass: `edit_note` liest mit `service.readNote` statt `enforceReadConsent` | `Tools.ts:994` | Auf `enforceReadConsent` umstellen |
| B9 | Ein korrupter `HashCache` setzt sich still zurück und löst ein volles Re-Embedding aus | `vault/src/Cache.ts:48` | Warnung ausgeben, Backup der kaputten Datei, atomar schreiben (tmp + rename) |
| B10 | Externe Deletes invalidieren die Topologie-Caches nicht. `graph()` ignoriert Aliase | `Service.ts:3147-3154`, `:2523` | `invalidateTopologyCaches()` aufrufen. Eine gemeinsame `LinkResolver`-Funktion für Graph, Backlinks und Adjazenz |
| B11 | `scryptSync` im Request-Pfad (ca. 50 ms Blockade). Mit falschen Tokens lässt sich der Server ausbremsen | `core/src/TokenHash.ts:26`, `PasswordHash.ts:21` | Asynchrones `crypto.scrypt` plus Negative-Cache |
| B12 | SessionStart-Hook übergibt `project` nicht | `plugins/synaipse-memory/hooks/session-start.sh:41-56` | `&project=$PROJECT_NAME` anhängen |

**Akzeptanz:** Alle Fixes haben Tests. Neu kommt eine Contract-Test-Suite, die **beide** NoteAdapter (Filesystem und MariaDB) gegen dieselben Erwartungen laufen lässt. Damit kann B3 nicht wieder entstehen.

### Status P0 (2026-11-18): umgesetzt, committet (`b79c5e3`..`6f220ca`)

Alle 12 Punkte sind erledigt. Die Suite steht bei 1080 Tests grün (vorher 1044), die MariaDB-Integration bei 25 Tests, gelaufen gegen einen Wegwerf-Container. Den Qdrant-Filter und den Dimensions-Check habe ich zusätzlich gegen eine echte Qdrant-Instanz verifiziert.

Bei der Umsetzung kam ein weiterer Fund dazu: **`update_note` hatte ebenfalls einen falschen `pathArg`** (`path` statt `id`). Ein Test prüft jetzt jeden `pathArg` gegen das Tool-Schema. Fehlt ein Pflicht-Pfadfeld, wird abgelehnt (fail-closed).

**Neue Bausteine:**

| Baustein | Inhalt |
|---|---|
| `core/LinkIndex.ts` | Inkrementeller Backlink-Index plus `buildLinkKeyMap`. Eine Auflösungsregel für Graph, Backlinks, `related` und das Such-Graph-Signal |
| `core/Markdown.ts` | Gemeinsame Wikilink- und Tag-Parser |
| `vector/VectorStore.ts` | Port. Qdrant ist austauschbar, Tests nutzen einen In-Memory-Store |
| `NoteEntry.embeddedHash` / `embedModel` | Plus Migration `009_notes_embedded.sql` und `LEGACY_EMBED_MODEL` |
| `verifyTokenAsync` / `verifyPasswordAsync` | Asynchrones scrypt |
| `isPathInScope` | Im Audit-Kontext |

**Verhaltensänderungen, die man kennen muss:**

- Ein Write schlägt **nicht mehr fehl**, wenn der Embedder ausfällt. Die Note ist gespeichert, das Problem wird als `pending` gezählt und beim nächsten Write oder Start nachgeholt.
- Auch der Start bricht bei einem Embedder-Ausfall nicht mehr ab. Er läuft im Fulltext-Modus weiter.
- **Server-Mode:** Der erste Start nach der Migration embedded **alle** Notes einmal neu. `embedded_hash` ist bewusst NULL, weil ein bisheriger Hash-Match nichts darüber aussagt, ob die Note wirklich im Vektorindex liegt.
- **Filesystem-Mode:** Bestehende Cache-Einträge werden als „legacy“ übernommen und **nicht** neu embedded.
- Tokens mit Pfad-Scope sehen in Such-, Listen- und Graph-Ergebnissen nur noch ihre Präfixe. `verify_history` und `snapshot_list` sind für sie gesperrt.
- Der Index-Cache wird atomar und kompakt geschrieben (ohne Pretty-Print). Ist er korrupt, wird er als `.corrupt-<ts>` gesichert und die Situation laut geloggt.

### Status P2 (2026-11-18): Kern umgesetzt, committet (`acf5f3c`..`b25286a`)

Suite 1108 grün. Tool-Liste von ca. 7k auf ca. 4,5k Tokens (31 sichtbare Tools); nur Toolset `core` ca. 2,6k (20 Tools). Gemessen als JSON-Zeichen/4.

| Punkt | Stand |
|---|---|
| B1 SDK, `instructions`, Annotations, kompaktes JSON, `isError` statt Protokollfehler, Enums ablehnen, `Tools/`-Split | erledigt. **Abweichung:** kein Umstieg auf `McpServer.registerTool`; der Low-Level-`Server` kann `instructions`, Annotations und `title` genauso, ohne alle Schemas nach zod zu portieren |
| B1 `outputSchema`/`structuredContent`, `resource_link` | offen → P8 (zusammen mit Resources) |
| B2 `synaipse_list`, `synaipse_links`, begrenzter `synaipse_graph`, `link_note` mit NoteRef-Validierung | erledigt. Alte Namen bleiben aufrufbar, sind aber aus `tools/list` versteckt (`DEPRECATED_TOOLS`) |
| B2 Admin-Gruppe hinter Flag | erledigt als `SYNAIPSE_MCP_TOOLSETS` (`core`, `roadmap`, `benchmark`, `admin`; `admin` default aus). `list_changed` entfällt, weil die Toolsets pro Prozess feststehen |
| B3 schlanke Write-Antworten mit Dead-Link-Warnungen, `read_note` mit Titel/Alias, `section`, Paging, Vorschlägen; ISO-Zeit plus Alter; Roadmap-Writes nur Gliederung | erledigt |
| B3 `search`-Filter und Treffer-Anker, globales `verbosity` | offen → P8. `verbosity` scheint nach den schlanken Defaults überflüssig |
| B6 Primer als `additionalContext` | erledigt (nicht bei `resume`, nicht wenn `CLAUDE.md` ihn noch importiert) |
| B6 Plugin-`.mcp.json`, Skill, Stop-Hook, Allowlist-Logging, `install-skill.mjs` | erledigt (P8 S8) |

**KPI-Lücke:** Das Ziel „Tool-Liste < 3k“ erreicht nur `SYNAIPSE_MCP_TOOLSETS=core`. Mit Roadmap und Benchmark (11 Tools) bleibt es bei ca. 4,5k. Weiter runter ginge nur, indem Roadmap/Benchmark per Default aus sind oder ihre Schemas Hinweise verlieren, die das Modell braucht.

**Verhaltensänderungen:** Write-Tools liefern nicht mehr die ganze Note. `read_note` kappt den Body standardmäßig bei 20.000 Zeichen (mit `next`-Hinweis). `synaipse_graph` liefert nie mehr den ganzen Vault, und Kanten kommen als `[from, to]`. `verify_history` und `snapshot_list` brauchen `SYNAIPSE_MCP_TOOLSETS=…,admin`. Ungültige Enum-Werte werden abgelehnt. Ein laufender Server braucht einen Neustart.


### Status P1 (2026-11-18): Fundament umgesetzt, committet (`8cda0db`..`2471e45`)

Suite 1127 grün (25 übersprungen), Lint ohne Fehler.

| Punkt | Stand |
|---|---|
| G3 CI-Gerüst | erledigt: `.github/workflows/ci.yml` mit Build, Lint und Test auf Node 22.13 und 24, dazu ein MariaDB-Job mit eigenem Service-Container. Bundle-Budget seit D4 drin; Bench-Gate und Playwright kommen mit A7 und P4 |
| G5 Pinning | erledigt: `ngit`, `vts` und `mdfloor` auf die Commit-SHAs aus dem Lockfile gepinnt; `engines.node >=22.13`, `.nvmrc`. **Offen:** vitest-Major-Update und Ersatz von `gray-matter` (braucht Round-Trip-Tests, eigener Slice) |
| A1 `LinkIndex` und Bulk-Write | erledigt: Backlinks werden inkrementell gepflegt, Tag-Index ebenso. `service.batch()` macht einen ngit-Commit, embeddet in Gruppen und flusht einmal. Crawler-CLI und Jobs (gitea, devto, github-stars, code) nutzen es |
| A1 persistente Titel/Alias-Indizes | offen. Die O(N)-Rescans in `related`, `prime`, `todos` usw. bleiben vorerst; sie sind erst ab ca. 50k Notes spürbar → mit A7-Bench messen, dann entscheiden |
| A2 SQLite-State | erledigt für die Index-Einträge: `<vault>/.synaipse/state.db` (`node:sqlite`, WAL), es werden nur geänderte Zeilen geschrieben, Fremdprozesse über `PRAGMA data_version` erkannt. Das alte JSON wird beim ersten Start importiert (ohne Re-Embedding) und als `*.migrated-<ts>` behalten. Mit echtem Vault-Abzug (2118 Einträge) geprüft: 0 Abweichungen, Import ca. 100 ms, 200 Zugriffe plus Flush ca. 3 ms. Such-Treffer zählen nicht mehr als Zugriff. **Offen:** Tabellen `audit`, `jobs`, `query_cache` (die Sidecars bleiben JSON, bis ein Slice sie braucht) |
| G2 Logging | erledigt mit eigenem, abhängigkeitsfreiem Logger (`core/Log.ts`) statt pino: Levels, `child`, Kontext-Provider, `SYNAIPSE_LOG_FORMAT=json`, immer stderr. Alle serverseitigen `stderr.write` wurden umgestellt; CLI-Ausgaben bleiben. **Abweichung:** kein pino, weil `core` auch im Browser läuft und der Bedarf klein ist. **Offen:** Request-IDs über den Kontext-Provider und `/api/metrics` |

**Verhaltensänderungen:** Der erste Start legt `.synaipse/state.db` an und benennt `.synaipse-index.json` um (die Rücksicherung ist einfaches Zurückbenennen, solange `state.db` gelöscht wird). Walker und Watcher ignorieren `.synaipse/` und `.ngit/`. Embed-Fortschritt pro Batch erscheint nur noch mit `SYNAIPSE_LOG_LEVEL=debug`.


### Status P3 (2026-11-18): Embed-Vertrag umgesetzt, committet (`868f12d`..`d35131d`)

Suite 1146 grün (25 übersprungen). Der Vertrag ist in [embedding.md](embedding.md) beschrieben. Geprüft im Browser gegen eine Wegwerf-Vault: Standalone-UI in beiden Themes und Lazy-Tabs. Dazu eine simulierte Host-Seite mit gleichnamigen Klassen: kein Style-Leck, Ctrl+K bei verstecktem Tab ignoriert. `unmount` schließt beide SSE-Streams, alle Intervalle, DOM und Portal; ein erneuter Mount funktioniert.

| Punkt | Stand |
|---|---|
| E1 `apiUrl()` | erledigt: alle 64 `/api`-Literale. `mount({apiBase})` setzt die Basis, der Host braucht keinen globalen Rewrite mehr |
| E1 `mount → MountHandle` | erledigt: `unmount`, `setTheme`, `navigate`, `onShow`/`onHide`. Login und Logout mounten neu statt `location.reload()`. `Main.ts` nutzt denselben `mount()` |
| E1 Theme am Container, Shortcuts nur sichtbar | erledigt. hljs beide Themes gescoped und einmal installiert |
| E1 `localStorage`-Präfix pro Instanz | offen: Schlüssel sind schon `synaipse.*`, eine Instanz pro Seite reicht vorerst |
| D1 `Disposables`, `View`, Tab-Registry, Lazy-Panels | erledigt (`Disposables.ts`, `Tabs.ts`). Haupt-Chunk 643 → 495 kB. **Offen:** reaktiver Kern (`Signal`) → P7 |
| D3 Scoping | erledigt: jede Regel unter `.synaipse-root` (Test als Wächter statt stylelint), Portal-Layer für Overlays, ein alter Kommentar-Bug (`.bm-kpis` verworfen) behoben. **Offen:** Datei-Split in `@layer`s, 63 Hex-Farben auf Tokens, Breakpoints → P7 |
| E2 explizite Config, `ready`/`health`, vollständiges `close`, Body robust, Typ-Export | erledigt (`startSynaipseEmbed`, `server/body.ts`, Exports `@synaipse/web/embed` und `/mount`) |
| E2 `registerTools` beim Host-Gateway, Auth-Brücke | offen, hängt an §13.2 |
| PKG-Studio-Seite | offen: Umstellung im Host-Repo, Schritte in embedding.md („Migrating PKG Studio“) |

**Nebenbefund:** Zeigte `SYNAIPSE_INDEX_CACHE` auf eine andere Vault, hat die Migration aus P1 deren Datei umbenannt. Behoben in `4e0d8b7`: Umbenannt wird nur noch innerhalb der eigenen Vault.

**Verhaltensänderungen:** Die Klasse `.root` bleibt (Host-CSS hängt daran); die eigenen Regeln nutzen `.synaipse-app` mit `height: 100%` statt `100vh`. Overlays liegen in `body > .synaipse-portal` statt direkt in `<body>`.

---

### Status P4 (2026-11-18): begonnen

| Punkt | Stand |
|---|---|
| A3 Louvain/Layout im Worker, stale-while-revalidate | erledigt (`f9e62fa`). `LayoutComputer` mit `worker_threads`, Fallback in-process. Nach Topologie-Änderung wird das alte Layout mit `stale: true` ausgeliefert, Neuberechnung debounced (750 ms). Atlas pollt nach, ohne den Viewport zurückzusetzen. 30k Knoten: max. Event-Loop-Verzögerung 1256 → 5 ms |
| A5 ETag/304 + vorkomprimierte Buffer für `/api/graph`, `/api/graph/layout` | erledigt (`e469062`, `cached-json.ts`): einmal stringify + gzip pro Objekt-Version, `Cache-Control: no-cache` |
| A5 Limits clampen | erledigt: `intParam` für search, history, activity, prime, local graph |
| A3 `suggestLinks` | erledigt (`433329d`): Semantik aus gespeicherten Vektoren (Qdrant `queryBatch` per Punkt-ID, kein Embed pro Notiz; Fallback nur für nicht embeddete Notizen), Tag-Paare über invertierten Tag-Index, Ergebnis-Cache pro Optionen + Vault-Generation mit stale-while-revalidate (neu verlinkte Paare werden aus dem alten Ergebnis gefiltert) |
| A3 HF-Embedder/Reranker im Worker | erledigt (`5b8b525`): ein gemeinsamer Worker statt Pool (jedes Modell einmal geladen), generisches `WorkerRpc` in `@synaipse/core/worker-rpc`, `LayoutComputer` nutzt es auch. 64-Chunk-Batch: Event-Loop vorher ~1,6 s blockiert, mit Worker frei. `SYNAIPSE_TRANSFORMERS_WORKER=0` schaltet zurück. Smoke mit HF-Embedder + Reranker gegen Wegwerf-Qdrant ok. **Offen:** mehrere Worker, falls Durchsatz nötig |
| A4 Chunk-Diff-Embedding | erledigt (`eea74ad`): Hash aus (Embedder-Fingerprint, Text) im Payload. Nur geänderte Chunks werden embedded, verschobene übernehmen ihren gespeicherten Vektor. Gegen Qdrant 1.18 geprüft: Anhängen an ein Log embedded 1 von 3 Chunks. Bestehende Punkte ohne Hash werden beim nächsten Schreiben einmal neu embedded |
| A4 Qdrant `query`-API mit `group_by: noteId` | erledigt (`eea74ad`): ein Treffer pro Notiz, Fallback auf `search` + Dedupe |
| A4 Projekt-/Pfad-Filter in Qdrant | erledigt: `SearchScope` (`include`/`exclude`-Präfixe, core `Scope.ts`). Jeder Chunk trägt `dirs` (alle Ordner-Präfixe, keyword-indiziert); Qdrant filtert per `match.any`, BM25 und Titel filtern vor dem Abschneiden. Alte Punkte werden beim ersten Scope-Einsatz einmal im Hintergrund nachgetaggt (bis dahin Over-Fetch + Nachfiltern). `service.search(…, scope)` schneidet automatisch mit dem MCP-Token-Scope. Genutzt von Chat, Chat-Preview, Relink (`exclude`), `/api/search?prefix=`, MCP `synaipse_search` (`pathPrefix`). Live gegen Qdrant 1.18: Projektsuche, bei der 30 fremde Notizen näher liegen, liefert 3 statt 0 Treffer. **Offen:** `suggestLinks`/`similarToChunks` filtern weiter nach |
| A4 Query-Embedding-Cache | erledigt: In-Memory-LRU (256) plus zweite Stufe in `state.db` (Tabelle `query_vectors`, StateDb-Migration 3, `vault/QueryVectorCache.ts`). Schlüssel = sha1(Fingerprint, Anfrage), der Klartext wird nicht gespeichert; Vektoren als Float64 (bitgleich), LRU auf 2000. Nur Local-Mode. Live mit MiniLM: wiederholte Anfrage nach Neustart 60 ms statt 510 ms |
| A4 paralleles `Vault.load`, Watcher-Ignores | erledigt (`c62c4bd`): 32 parallele Reads, gemeinsame Ignore-Regel für Walker und Watcher. Nicht gemessen |
| A4 Speicher | Messung (Kopie der echten Vault, 3264 Notizen, 35 MB Markdown): Server-Heap 409 MB, davon Volltext-Index 267 MB, Notiztexte nur ≈ 60 MB. Daher statt Lazy-Bodies: (1) gray-matter-Cache abgeschaltet (`50c579b`), der jede geparste Dateiversion samt Buffer ewig hielt (200 Edits einer 110-KB-Notiz: +43 MB → +0,3 MB). (2) Kompakter `InvertedIndex`: Term-/Doc-Nummern, Postings als `Uint32Array`, Term-Strings entkoppelt (pinnten ganze kleingeschriebene Bodies). Index 267 → 58 MB, Heap 409 → 199 MB, Suche 0,49 → 0,34 ms; Treffer und Scores bitgleich (Äquivalenztest gegen die alte Implementierung). **Offen:** Bodies lazy laden (spart ≈ 60 MB, rund 100 synchrone `content`-Zugriffe) |
| A5 Router-Table | erledigt: `server/router.ts` (Muster mit `:id` / `:id+`, 405 bei falscher Methode, zentrales Fehler-Mapping `HttpError`→Status, zu großer Body→413, kaputtes JSON→400, Rest→500 mit Log). `routes.ts` von 1444 auf ~110 Zeilen, Routen in `server/routes/` pro Domäne (notes, graph, project, chat, memory, ingest, system). Auth/Tokens/Admin/Consent/Schedules bleiben eigene Module. **Offen:** Schema-Validierung (VTS ist nicht im Stack) |
| A5 `readJson` mit Byte-Limit | erledigt: 8 MiB Default für alle JSON-Bodies inkl. Auth/Admin/Tokens, 413 |
| A5 Cursor-Pagination | erledigt: `/api/notes?limit&cursor&prefix` (Keyset nach id, ohne Parameter weiter das volle Array für den Baum), `/api/audit?cursor` (Zeilennummer im append-only Log, nur `limit+1` Einträge im Speicher, Default 200 statt unbegrenzt), neu `/api/activity/commits?cursor` (Keyset nach sha, stabil bei neuen Commits). UI: „Ältere laden“ in Audit und Activity. Cursor sind opak (base64url-JSON), kaputte → 400 |
| A5 Graph-Deltas per SSE | erledigt: `server/graph-deltas.ts` diff't nach Writes (Debounce 250 ms, spätestens nach 1 s) den alten gegen den neuen Stand (Knoten, Kanten, Notiz-Übersichten) und sendet `event: graph-delta` mit `from`/`to`. Versionen kommen als `X-Synaipse-Version` mit `/api/notes` und `/api/graph`; bei Lücke, Reconnect oder > 5000 Änderungen lädt der Client neu (`graph-reset`). Ohne SSE-Client keine Arbeit. Die 2D-Ansicht gleicht Graph-Elemente ab (seit P6 in jsNGraph) statt neu aufzubauen (stabile Kanten-IDs): Kamera und Positionen bleiben bei Writes stehen. Browser geprüft: nach einem Write nur noch der PUT, kein Nachladen. **Offen:** 3D-Ansicht baut weiter neu auf (kommt mit P6) |
| A5 JobManager in SQLite | erledigt: Tabelle `jobs` in `state.db` (StateDb-Migration 2), `server/job-store.ts`. Höchstens ein laufender Job pro Typ, weitere warten als `queued` und starten nach dem Ende des Batches. Jeder Lauf in `service.batch()` (ein Commit, gebündeltes Embedding). Historie (30) übersteht Neustarts; was beim Absturz lief oder wartete, wird als `failed` geschlossen, nicht neu gestartet. Tokens/API-Keys in den Parametern werden nicht gespeichert (`***`). Live geprüft inkl. `kill -9`. Server-Mode hält Jobs weiter im Speicher |
| D5 Chat-Streaming | erledigt: Tokens patchen nur noch den Text der laufenden Antwortblase, höchstens einmal pro Frame mit adaptiver Drossel (`FrameThrottle`, Render ≤ 1/3 der Zeit), ohne antv-/Floorplan-Hydration bis zum Ende. Senden hängt neue Nachrichten an statt den Verlauf neu zu bauen; Auto-Scroll nur, wenn man unten ist; Footer (aufgeklappte Quellen) bleibt stehen. Browser mit Fake-LLM (18 000 Zeichen, 2 900 Tokens, 40 Codeblöcke): vorher Tab > 45 s blockiert, jetzt so schnell wie der Stream (≈ 6 s), 10–12 Renders statt 2 900 |
| D4 Bundle-Budget | erledigt: Entry-Chunk 506 → 244 KB (gzip 155 → 70 KB), Ziel < 250 KB erreicht. highlight.js als Hydration-Pass (`CodeHighlight.ts`, lädt beim ersten Codeblock; PDF-Export wartet darauf), marked-highlight entfernt; jszip erst beim ChatGPT-Import. `scripts/check-bundle-budget.mjs` (`npm run bundle:check`, in CI): Initial-JS ≤ 260 KB / 80 KB gzip, jeder Lazy-Chunk ≤ 1,6 MB. Browser: Notizvorschau und Chat-Stream (40 Blöcke) gefärbt, beim Start weder hljs noch jszip geladen. cytoscape (455 KB) seit P6 S2 durch jsNGraph (≈ 112 KB) ersetzt. **Offen:** @antv (808 KB, lazy) |
| D5 Listen-Virtualisierung | bewusst nicht gebaut: Jobs halten höchstens 30 Einträge, Activity (50) und Audit (200) laden seitenweise per Klick, echte Vault hat 5 Audit-Einträge und 2 Chats. Browser-Messung mit 2 000 synthetischen Audit-Einträgen: Scrollen im Median 60 fps, Nachladen ≈ 100 ms pro Seite. Stattdessen Audit-Details erst beim Aufklappen gebaut: 56 500 → 24 000 DOM-Knoten. Neu bewerten, wenn eine Liste ohne Pagination wächst (Server-Mode) |

### Status P5 (2026-11-18): umgesetzt (jsNGraph 0.2.0 + S1 lokaler Graph)

Im jsNGraph-Repo (`9022c86`, `cc8b858`, Release `815e977`; `main` gepusht, der Tag `v0.2.0` liegt nur lokal, Synaipse pinnt deshalb den Commit-SHA):

- J1 Camera in NGraph (`panZoom` opt-in, `fit`/`focusNode`/`zoomTo`/Viewport, animierte Flüge).
- J2 Style-Layer (`dot`, `color`/`size`/`group`, Edge-`kind`/`directed`/`dashed`/`label`, `EdgeKindPresets.knowledge`, `styleNode`/`styleEdge`).
- J3 Quadtree für Hit-Test und Lasso, Viewport-Culling.
- J7 highlight/filter/neighborhood/Selection/Lasso und Events.
- J9 On-demand-`RenderLoop` und Pause bei hidden bzw. 0×0. Dafür bekam `ForceLayout` ein Alpha-Cooling (Vorgriff auf J5), sonst wäre der Loop nie leer gelaufen.
- J10 `Theme.fromCssVars`.
- J13 Version 0.2.0 mit Tag.
- Neues Beispiel `examples/knowledge.html`. 66 Tests grün, alle Beispiele im Browser geprüft.

S1 in Synaipse:

- Backend: `GET /api/graph/local?id&depth&limit` (`service/LocalGraph.ts`). Wikilinks in beide Richtungen plus typisierte Frontmatter-Links, begrenzt auf 1 bis 3 Hops und 60 Knoten, die besser vernetzten zuerst.
- UI: `LocalGraphPanel` im Viewer, als erster Block über „Linked from“.
  - Radial-Layout, Ring = Hop. Ring 2 wird nach dem Elternwinkel rotiert, damit sich weniger Kanten kreuzen.
  - Knoten nach Ordner eingefärbt; typisierte Kanten gerichtet und beschriftet.
  - Klick öffnet die Notiz, Hover hebt die Nachbarn hervor.
  - Umschalter 1/2 Hops, Fit-Button; Zustand (aufgeklappt, Tiefe) bleibt gespeichert.
  - Theme kommt per `Theme.fromCssVars` aus den Synaipse-Tokens.
  - jsNGraph wird lazy geladen: Der Haupt-Chunk schrumpft von 557 auf 503 KB, jsNGraph liegt als eigener 106-KB-Chunk vor.
- Git-Dependencies brauchen unter npm 12 `npm install --allow-git=root`.

Offen bzw. Folgearbeit:

- Label-Kollision in dichten Graphen (J4/P6).
- Mindest-Trefferfläche kleiner Punkte (6 px) ist knapp.
- Subpath-Exports in jsNGraph, damit der Lazy-Chunk nicht den Rect-Kit und ModelView mitschleppt.
- Tag `v0.2.0` pushen.

### Status P6 (2026-11-18): umgesetzt (J4/J5/J6/J8 + S2 + S3, 2D/Atlas vereint)

Im jsNGraph-Repo (`1f8a191`, `07715fb`, gepusht):

- J5 nur als `layoutMode: 'static'` (vorberechnete Server-Positionen). Barnes-Hut und Worker bewusst nicht gebaut (Nutzer-Entscheidung).
- J4 Label-Kollision und Kanten-Batching. Pfeilspitzen werden in 64er-Chunks gefüllt, unter 2 px weggelassen (ein `fill()` über 5000 Teilpfade kostete in Chrome ≈ 250 ms).
- J4 LOD und Aggregation (`25d3dbe`, gepusht): `setClusters`/`clusterAt`/`focusCluster`/`isClustered` und Event `clusterClick`. Unter `clusterZoom` zeichnet jsNGraph Cluster-Scheiben (Größe nach Mitgliederzahl, begrenzt durch die Ausdehnung des Clusters) mit gewichteten Sammelkanten; Labels nur, wo sie keine Scheibe verdecken. Dazu `edgeMinZoom`, Viewport-Culling per Quadtree ab 2000 Knoten, Punkte unter 2 px als gebündelte Quadrate, `repaint()`. Beispiel `examples/atlas.html`. Gemessen mit 100 000 Notizen in der Übersicht: vorher ≈ 500 ms pro Frame, mit Clustern ≈ 3 ms, ohne Cluster ≈ 60 ms. `vault.html` mit 3000 und 6000 Notizen ist gleich schnell oder schneller.
- J6 `setHulls`/`hullsAt` (Cluster-Hüllen), `NodeStyle.ring`.
- J8 `addOverlay` plus Effekte `pulse`/`trail`/`ripple`; Beispiel `examples/vault.html`.

S2 in Synaipse (`0c3acd0`):

- `Graph.ts` rendert über jsNGraph. Positionen kommen aus `GraphPositions.ts` (resolvePositions + gespeicherte Drag-Positionen).
- Hüllen, Heat-Ring und SSE-Effekte laufen über jsNGraph; `Hulls.ts` und das SVG-Overlay sind weg.
- `GraphStyle.ts` (Lazy-Loader, Kanten-Arten, Theme) teilen sich Graph und `LocalGraphPanel`.
- Fix: Der Heat-Schalter kommt jetzt über `applyGraphFilter` im View-State an (vorher nie, betraf alle Ansichten).
- cytoscape und `@types/cytoscape` sind entfernt. Der jsNGraph-Chunk hat ≈ 112 KB statt 455 KB für cytoscape.
- Browser: 3120 Notizen ≈ 15 ms pro Frame.
- 1212 Tests grün, Bundle-Budget ok.

S3 in Synaipse (`9ead549`):

- `GraphAtlas.ts` ist ein Adapter: Server-Layout → NGraph über `buildAtlas` (rein, getestet). Communities sind Cluster (Klick zoomt hinein), Notizen ab Zoom 0,5, Kanten ab 1, Labels ab 1,5. `Quadtree.ts` und der handgeschriebene Canvas-Renderer sind weg.
- Neu im Atlas: Heat-Ringe, Effekte (pulse/trail/ripple), Tag-Filter per jsNGraph-Filter. Live-Updates behalten die Kamera; vorher wurde bei jeder Datenänderung neu eingepasst.
- Fix: Bei Datenänderungen lädt der Atlas das Layout mit `force`. Der Client-Cache kannte nur Writes aus der eigenen UI, MCP-Writes blieben bis zu 60 s unsichtbar.
- Browser mit einer 25k-Smoke-Vault: Frames ≤ 11 ms auf jeder Zoomstufe (Cluster 4–11 ms, Notizen ≤ 4 ms). Neue Notiz per Write nach ≈ 2,4 s sichtbar.

Louvain-Fix (`2617b15`), beim Smoke-Test gefunden: Die Community-Erkennung verglich Wechsel gegen 0 statt gegen das Bleiben in der eigenen Community. Die Modularität wurde auf dem kollabierten Graphen berechnet, und Self-Loops wurden halbiert. Ergebnis in der 25k-Vault vorher: eine Community mit 23 389 Notizen, Modularität −0,50. Nachher: 1563 Communities, die größte mit 563 Notizen, Modularität 0,87. Der Algorithmus liegt jetzt einmal in `@synaipse/core/louvain`, statt in zwei identischen Kopien. Der Layout-Hash (= ETag) enthält `LAYOUT_ALGORITHM_VERSION`; sonst hätten Browser per 304 das alte Layout behalten.

2D und Atlas zusammengelegt (2026-11-18): Es gibt nur noch eine 2D-Ansicht für jede Vault-Größe; die Notizanzahl ändert nur den Detailgrad. Bis 2999 Notizen platziert der Client (gespeicherte Anordnung, ziehbar, Tag-Hüllen); ab 3000 übernimmt das Server-Layout mit Community-Scheiben beim Herauszoomen (`choosePlacement`, zurück erst unter 2500, damit eine Vault an der Grenze nicht bei jedem Write springt). Der Wechsel passiert live ohne Neuladen. `GraphAtlas.ts` ist aufgegangen in `ServerLayout.ts` (`buildServerGraph`, `ServerLayoutFeed`) und `Graph.ts`. Der Atlas-Knopf ist weg; ein gespeichertes `atlas` liest sich als 2D. Ab 5k Notizen warnt nur noch 3D, ab 20k ist 3D aus. Lock auf jsNGraph `25d3dbe` (`dd20a46`). Browser: 25k-Vault zeigt die Übersicht in 2D, Klick auf Community zoomt hinein; 2999-Vault zeigt Client-Positionen, die 3000. Notiz per Write schaltet ohne Konsolenfehler um. Hüllen gibt es im Server-Layout nicht.

Server-Layout-Packung (2026-11-18): Die Reihen-Anordnung ist durch eine Kreispackung ersetzt (Front-Chain wie d3 `packSiblings`, `packCircles` in `Layout.ts`), größte Community in der Mitte. Notizen ohne Link zu einer anderen Notiz bilden eine gemeinsame Gruppe (`unlinked: true`, im Client beschriftet „unlinked notes“) am Rand statt je eine Kachel. Kachel-Abstand wächst mit der Größe (24 px + 8 %) statt fester 80 px; innerhalb einer Kachel liegen die bestvernetzten Notizen in der Mitte. `LAYOUT_ALGORITHM_VERSION` = 3. Gemessen (synthetisch, 25k Notizen): Seitenverhältnis 4,05 → 1,26, belegte Fläche 24 % → 57 %, Fläche pro Notiz 25 300 → 5 600 px², Kacheln 2114 → 250. Bei 200k Notizen Seitenverhältnis 1,03. Die Packung selbst kostet bei 50 000 Kreisen ≈ 3,8 s (im Worker); bei realistischen Community-Zahlen ist sie vernachlässigbar. Browser mit der 25k-Vault: runde Übersicht, Tooltip der Gruppe ok, keine Konsolenfehler.

Offen bzw. Folgearbeit:

- Der ForceLayout-Test „speed cap“ in jsNGraph flackert gelegentlich (war schon vorher so).
- Das in den Webserver eingehängte `/mcp` postet keine Live-Events. Getestet wurde deshalb über `POST /api/events`.

### Status P8 (2026-11-18): erledigt

Slices (in dieser Reihenfolge; jede endet mit `npm run eval` gegen die Baseline):

| Slice | Inhalt | Stand |
|---|---|---|
| S1 B7 Eval-Harness | Fixture-Vault, Fragen-Kategorien, MCP-Agent, Baseline, CI | erledigt |
| S2 B4 Ranking | `supersedes`, `confidence`, `valid_until` wirken in `search` und `prime` | erledigt |
| S3 B4 Schreiben | `possibleDuplicates[]` bei `write_note`/`remember`, `mode: create\|overwrite\|upsert`, `expectedHash` | erledigt |
| S4 B4 Zeit + Inbox | `synaipse_changes`, `synaipse_note_history`, Kandidaten für `consolidate_inbox`; dazu B3 `search`-Filter und Treffer-Anker | erledigt |
| S5 B5 Resources/Prompts/Completions | dazu B1 `outputSchema`/`structuredContent`, `resource_link` | erledigt |
| S6 B5 Elicitation | `delete_note`, Consent-Flow statt Long-Poll, Progress, HTTP-Session-TTL | erledigt |
| S7 C5 Inbox-UI | Übernehmen in eine Note, Verwerfen | erledigt |
| S8 B6 Plugin-Rest | `.mcp.json`, Skill, Stop-Hook, Allowlist-Logging, `install-skill.mjs` | erledigt |

S1: `npm run eval` (`vitest.eval.config.ts`, in CI nach `bundle:check`). `packages/mcp-server/eval/fixture.ts` ist eine Vault mit 38 Notizen (zwei Projekte plus geteiltes Wissen) und 32 Fragen in fünf Kategorien: `lookup`, `paraphrase`, `current` (abgelöste Entscheidung neben der aktuellen), `trust` (niedrige `confidence`, abgelaufenes `valid_until`) und `scoped` (gleiches Thema in beiden Projekten). Ein geskripteter Agent ruft wie vom Arbeitsprotokoll vorgesehen `synaipse_search` (limit 5) und `synaipse_read_note` auf den Top-Treffer auf, jede Frage in einer frischen Vault (`e27eb02`). Gemessen: hit@1, Recall@5, MRR, Anteil der Fragen mit veralteter Notiz vor der Antwort, Tokens pro Frage (Zeichen / 4) sowie Kontextkosten (Tool-Liste, Instructions, Prime). `eval/baseline.json` ist eingecheckt; schlechtere Werte (Tokens: mehr als 5 % mehr) lassen den Lauf scheitern, `EVAL_UPDATE_BASELINE=1 npm run eval` schreibt eine neue Baseline. Ohne Embeddings (offline, deterministisch).

Baseline (altes Ranking, isoliert): hit@1 0,75, Recall@5 0,953, MRR 0,84, **veraltete Notiz vor der Antwort in 45 % der betroffenen Fragen**, 483 Tokens pro Frage. In C5 (Frage nach der Session-TTL) fehlte die aktuelle Notiz ganz in den Top 5. Kontext: Tool-Liste ≈ 4500 Tokens (Ziel < 3k), Instructions 266, Prime ≈ 1000.

Befund nebenbei: Im ersten Entwurf liefen alle Fragen in einer Sitzung. Jedes `read_note` zählt als Zugriff und macht die Notiz zum Graph-Seed der Hybrid-Suche; dadurch verschlechterte sich das Ranking der folgenden Fragen (hit@1 0,625 statt 0,75). Für echte Sitzungen heißt das: Das Graph-Signal aus kürzlich gelesenen Notizen kann themenfremde Treffer nach oben ziehen. Eigener Punkt für später (Seeds nach Thema filtern oder Gewicht senken), gemessen mit einer Sitzungs-Variante der Eval.

S2 (`309bc6c`, `d3643d5`): neues Modul `KnowledgeState.ts`. `supersedes` (Feld oder typisierter Link, per Pfad, Titel oder Alias; Ketten bis zum letzten Nachfolger, Zyklen zählen nicht) senkt das Gewicht auf 0,25, abgelaufenes `valid_until` auf 0,3, `confidence` c auf 0,5 + 0,5·c. Treffer werden markiert (`supersededBy`, `expired`, `confidence`); der Nachfolger eines abgelösten Treffers bekommt mindestens dessen ursprünglichen Score, aber nur innerhalb des Such-Scopes. `prime` lässt abgelöste und abgelaufene Notizen weg (außer gepinnte), `read_note` nennt den Nachfolger, die Instructions sagen dem Agenten, `supersedes` zu setzen. Eval: veraltete Notiz vor der Antwort 45 % → 0 %, hit@1 0,75 → 0,84, MRR 0,84 → 0,91, Recall@5 0,95 → 0,98, Prime 1019 → 824 Tokens, Instructions +39 Tokens.

S3 (`952da7e`): `write_note` nimmt `mode: create|overwrite|upsert` (Default `upsert`, unbekannte Werte werden abgelehnt) und `expectedHash`; `update_note` und `edit_note` nehmen `expectedHash`, `edit_note` sichert zusätzlich immer gegen eine Änderung zwischen eigenem Lesen und Schreiben. Ein verletzter Guard ist ein Tool-Fehler mit aktuellem Hash (`WriteConflictError`), geschrieben wird nichts. Prüfung und Schreiben laufen unter einer Sperre pro Pfad; von zwei Schreibern mit demselben Hash kommt nur einer durch. Neue Notizen und `remember`-Einträge melden `possibleDuplicates` (höchstens 3, `Duplicates.ts`): Kandidaten aus der Hybrid-Suche, bewertet nach Wortüberlappung (Jaccard bzw. 0,8 × Enthaltensein für kurze Einträge, nahezu gleiche Titel) oder Kosinus ≥ 0,88 bei Embeddings. Schwelle 0,42, kalibriert mit zehn Entwürfen in der Eval: Duplikate in anderen Worten ab ≈ 0,5, neues Wissen mit gemeinsamem Vokabular bis ≈ 0,35. Die Eval misst das jetzt mit (Recall der Duplikate, Anteil Fehlalarme): Recall 1, Fehlalarme 0. Tool-Liste +3,6 % Tokens durch die neuen Parameter.

S4 (`6e5d51c`): Statt eines eigenen `synaipse_changes` nimmt `synaipse_list` jetzt `since` (ISO-Datum oder `24h`/`7d`/`2w`) und meldet dann zusätzlich `removed`: seitdem gelöschte oder archivierte Notizen, die noch fehlen, aus der Versionsgeschichte. Ein Tool weniger in der Liste. `synaipse_note_history` listet die Versionen einer Notiz (`sha`, Alter, Tool) und liefert mit `diff` den Unified-Diff von einer älteren Version bis heute (gekappt bei 8000 Zeichen). `synaipse_consolidate_inbox` liefert die `remember`-Einträge des Projekts mit `alreadyIn` (Notizen, die das schon sagen: Eintrag kann weg) und `targets` (kuratierte Notizen zum Einarbeiten); es schlägt nur vor, schreiben tut der Agent. `synaipse_search` nimmt `tags` (alle) und `since`; die ersten fünf Treffer nennen den passenden Abschnitt samt Zeilenbereich (`Inbox.ts` `bestSection`, nur bei Notizen mit mindestens zwei Überschriften), den `read_note` mit `section` gezielt liest. Eval: drei neue Fragen mit der Antwort in einem Abschnitt einer langen Notiz; den Abschnitt statt der ganzen Notiz zu lesen spart rund 6 % Tokens pro Frage (516 → 501). Tool-Liste 4644 → 5065 Tokens (+9 %), Baseline bewusst nachgezogen.

S5 (`4a79623`): Resources `synaipse://note/{+path}` (rohes Markdown, damit Clients Notizen per `@` erwähnen können) und `synaipse://project/{p}/primer|roadmap|convention`. Sie werden über die Lese-Tools (`read_note`, `prime`, `roadmap_get`) mit derselben Scope-Prüfung, demselben Audit-Kontext und Consent-Filter gelesen (`Resources.ts`); eine Resource zeigt nie mehr als das Tool. `resources/list` liefert die Projekt-Resources und die Notizen neueste zuerst, 200 pro Seite. Prompts `session-to-vault`, `consolidate-inbox`, `record-adr`, `roadmap-review` (Projekt-Prompts nur mit Projekt, `roadmap-review` nur mit Roadmap-Toolset). Completions für Notiz-Pfade (Präfix, dann Teilstring), Projekte und `since`. `search`, `read_note`, `list`, `note_history` und die drei Schreib-Tools haben ein `outputSchema` und liefern `structuredContent` (dasselbe Objekt wie der Text; `Tools/OutputSchemas.ts`, angehängt in `Acl.ts`). Schreib-Ergebnisse tragen einen `resource_link` auf die Notiz. Die Eval zählt für die Tool-Liste jetzt nur, was beim Modell ankommt (Name, Beschreibung, Input-Schema): 4218 Tokens. Offen: ob Claude Code bei `structuredContent` zusätzlich den Text an das Modell gibt (dann doppelte Tokens für diese sieben Tools), ist nicht live geprüft.

S6 (`d8b3071`): `delete_note` fragt per Form-Elicitation nach, wenn der Client das kann; die Frage sagt, ob die Notiz aus der Versionsgeschichte wiederherstellbar ist. Ablehnen, Abbrechen oder keine Antwort (Timeout 10 min, Fehler) löschen nichts und liefern `{deleted: false, reason}`; Clients ohne Elicitation löschen wie bisher. Tool-Aufrufe mit `progressToken` bekommen alle 5 s eine Progress-Meldung, damit lange Aufrufe nicht in Client-Timeouts laufen (`ToolCall` im `ToolContext`). Bewusste Abweichung beim Consent: Die Elicitation ersetzt die Freigabe im Synaipse-UI **nicht**, denn ein Client kann eine Elicitation automatisch bestätigen und würde so den Consent-Layer aushebeln. Stattdessen meldet das Warten Fortschritt („Waiting for consent in the Synaipse UI …“) und endet, wenn der Aufruf abgebrochen wird; die Anfrage bleibt im UI offen. HTTP-Sessions schließen nach 30 min ohne Anfrage (`SYNAIPSE_MCP_SESSION_TTL_MS`), über 1000 offene Sessions schließt die am längsten ungenutzte (`SYNAIPSE_MCP_MAX_SESSIONS`); Sessions mit laufender Anfrage bleiben (`Sessions.ts`). Elicitation ist auch über Streamable HTTP getestet (Rückfrage über den Stream des Tool-Aufrufs).

S7 (`0d7622e`): Neuer Tab „Inbox“ (`InboxPanel.ts`) zeigt die `remember`-Einträge eines Projekts nach Tag, je Eintrag die Notizen, die ihn vermutlich schon enthalten (dann ist „Verwerfen“ hervorgehoben), und kuratierte Notizen zum selben Thema. „Übernehmen“ hängt den Text, auf Wunsch bearbeitet, an eine vorgeschlagene Notiz, an eine beliebige andere (Titel oder Pfad) oder legt eine neue Notiz an; „Verwerfen“ entfernt den Eintrag. Beides sind versionierte Schreibvorgänge mit Hash-Guard; eine Inbox-Notiz ohne Einträge wird gelöscht. Ein Eintrag wird über Inbox-Notiz, Uhrzeit und Text identifiziert, weil mehrere Einträge dieselbe Minute haben können. API: `GET /api/inboxes`, `GET /api/inbox`, `POST /api/inbox/promote`, `POST /api/inbox/discard` (veralteter Eintrag → 409). Browser-Smoke gegen eine isolierte Vault: alle drei Wege (verwerfen, in bestehende Notiz mit bearbeitetem Text, in neue Notiz) und die Meldung bei fehlendem Titel geprüft, keine Konsolenfehler, echte Vault unverändert.

S8 (`061a09c`): Das Plugin registriert den MCP-Server selbst (`.mcp.json`): URL `/mcp/${SYNAIPSE_PROJECT:-}` und Header `X-Synaipse-Project-Dir: ${CLAUDE_PROJECT_DIR}`. Ohne ausdrückliches Projekt nimmt der Server jetzt den Ordnernamen daraus (Zeichen außerhalb `A-Za-z0-9_.-` → `-`), denselben Namen, den der SessionStart-Hook für den Primer nutzt. Live mit Claude Code 2.1.316 geprüft: Die Variablen werden nur in Plugin-Configs ersetzt, in einer Projekt-`.mcp.json` fehlt `CLAUDE_PROJECT_DIR`; `claude mcp list` mit dem Plugin verbindet gegen eine isolierte Instanz, der Server erkennt das Projekt. Skill `synaipse-memory` mit dem Arbeitsprotokoll. `PostToolUse` protokolliert Synaipse-Aufrufe als `{kind: synaipse, op, write, notes[]}` (beide Server-Präfixe), `SessionEnd` ergänzt `synaipse_notes_used` und `synaipse_writes`. Der Stop-Hook erinnert einmal pro Session ans Speichern, wenn mindestens drei Code-Änderungen und kein Synaipse-Schreibvorgang vorliegen (`SYNAIPSE_STOP_NUDGE=0` schaltet ab). `install-skill`: `claude-code` schreibt `./.mcp.json` mit `/mcp/<Ordner>` (`--user` für `~/.claude.json`, `--project=<name>`), Cursor-Workspace ebenso, stdio setzt `SYNAIPSE_PROJECT`. Hooks sind mit echten bash/jq-Läufen getestet (`plugin-hooks.test.ts`).

P8-Bilanz (Eval, ohne Embeddings): veraltete Notiz vor der Antwort 45 % → 0, hit@1 0,75 → 0,83 (bei 35 statt 32 Fragen), MRR 0,84 → 0,89, Duplikat-Erkennung Recall 1 ohne Fehlalarm, Prime 1019 → 824 Tokens. Offen aus P8: Claude Code live prüfen, ob `structuredContent` zusätzlich zum Text beim Modell landet (S5); Graph-Seeds aus kürzlich gelesenen Notizen nach Thema filtern (S1-Befund).


### Status P9 (2026-11-18): erledigt

| Slice | Inhalt | Stand |
|---|---|---|
| S1 E3 Tokens | `var(--sh-*, eigener Wert)` für Flächen, Linien, Text, Akzent, Status, Radien, Schrift; `onThemeChange` im Mount-Vertrag | erledigt |
| S2 E2 MCP-Registrar | Synaipse-Tools auf dem `McpServer` des Host-Gateways | erledigt |
| S3 E4 Lib-Build | `mount` als ESM-Library mit eigener CSS-Datei aus `dist/`, Export statt Source-Alias | erledigt |
| S4 E4 Manifest | `pkgstudio.module.json` (id, label, color, entries, capabilities) | erledigt |
| S5 E4 Paket-Split | `@synaipse/web-client` und `@synaipse/web-api`, Server-Image ohne Browser-Abhängigkeiten | erledigt |

S1: Alle Grund-Tokens in `Styles.css` lesen zuerst den Host-Token (`--bg-1: var(--sh-surface, #11141a)`); Fokusring, `--accent-soft` und `--gold-soft` werden per `color-mix` aus Akzent bzw. Warnfarbe abgeleitet und folgen damit dem Host. Standalone ist nichts gesetzt: Im Browser geprüft, dass alle abgeleiteten Farben exakt den alten `rgba`-Werten entsprechen; mit gesetzten `--sh-accent`/`--sh-surface` übernimmt Synaipse sie, ohne sie wieder die eigenen. `mount()` hat jetzt `onThemeChange` (einmal nach dem Mount und bei jedem Wechsel) und `handle.getTheme()`, damit der Host seine Shell-Tokens zum gezeigten Theme passend setzt. Vertrag mit Token-Tabelle in `doc/embedding.md`.

S2: `createSynaipseRegistrar(service, {project, toolsets})` in `@synaipse/mcp-server` und `embed.mcpRegistrar` für PKG Studios `mountMcp(app, path, registrars)`. Tool-Ausführung (Scope-Prüfung, Audit-Kontext, Live-Event, Bestätigung, Fortschritt) liegt jetzt in `ToolRunner.ts` und ist für den eigenen Endpoint und das Gateway dieselbe. Die JSON Schemas werden per `z.fromJSONSchema` zu zod (das verlangt `McpServer`); Feldnamen und Pflichtfelder überstehen den Rundweg für alle 35 sichtbaren Tools, auch gegen SDK 1.32.1 und zod 4.6.5 aus dem PKG-Studio-Repo geprüft. Volle Rechte im Projekt der Host-Config; im Server-Modus registriert der Registrar nichts. Resources, Prompts, Completions und Server-Instructions bleiben am Synaipse-Endpoint, weil sie Protokoll-Handler belegen, die die des Gateways ersetzen würden; dafür bräuchte das Gateway eine Registrar-API mit Resources und Prompts (Gegenplan). Eval unverändert (Tool-Liste 4244 Tokens).

S3: `vite.lib.config.ts` baut `mount` nach `dist/lib` (`mount.js` + Chunks + `synaipse.css`), alle Abhängigkeiten gebündelt, Panels und schwere Bibliotheken bleiben eigene Chunks. `process.env.NODE_ENV`/`LANG` werden im Lib-Build festgesetzt, weil Vite sie im Lib-Modus nicht ersetzt und 3d-force-graph sie im Konstruktor liest (im Browser wäre das ein ReferenceError). Exports: `./mount` → `dist/lib/mount.js` (Typen aus `dist/src/mount.d.ts`), `./mount.css`, `./mount/source` für die Entwicklung. `npm run build` baut beides. Geprüft mit einem eigenen Vite-Host, der nur über die Package-Exports importiert, gegen einen isolierten Server: Mount, Host-Akzent, `onThemeChange`, alle zehn Panels und der 3D-Graph laden aus `dist/lib` ohne Fehler.

S4: `pkgstudio.module.json` im Repo-Root, Feldnamen wie `ModuleConfig` in PKG Studio (`id`, `label`, `color`, `theme`, `projectScoped`, `mcpPath`), dazu `entries.frontend` (Bundle, CSS, Export, Source, Package-Export), `entries.backend` (`startSynaipseEmbed`), `build`, `capabilities` (8 feste Werte) und `config` (`.env`, `SYNAIPSE_PROJECT`). Schema als Vertrag für den Gegenplan: `doc/pkgstudio.module.schema.json`. `manifest.test.ts` prüft gegen das Schema, gegen die Package-Exports, gegen die echten Exportnamen und dass jede deklarierte Capability im Code steht.

S5: `packages/web` aufgeteilt in `@synaipse/web-client` (`src`, `index.html`, beide Vite-Configs, 20 Client-Tests) und `@synaipse/web-api` (`server`, 16 Tests inkl. Manifest; `graphDeltas.test.ts` prüft den Rundweg Server→Client und importiert den Client-Teil relativ). Alles, was der Browser-Code importiert, wird gebündelt und ist deshalb devDependency von web-client: Produktions-Pakete laut Lockfile 417 → 297 (three, @antv/infographic, 3d-force-graph, jsngraph, marked, highlight.js, jszip, mdfloor raus), rund 230 MB weniger. Dockerfile, Compose, `bench-scale`, `check-bundle-budget`, ESLint, Root-Scripts, Manifest und Doku nachgezogen; die Migration `007_schedules.sql` bewusst nicht angefasst (nur ein Kommentar, aber Migrationen bleiben unverändert). PKG Studio braucht danach neue Pfade (`embedEntry`, `MODULE_ENTRY`, `ModuleLoaders.ts`), Schritt 0 in `doc/embedding.md`. Docker-Image gebaut und geprüft: three, @antv/infographic, 3d-force-graph, jsngraph, marked, highlight.js, jszip, mdfloor fehlen im Image, `node_modules` 104 MB, Image 367 MB; der Server startet und liefert API und UI aus `packages/web-client/dist/web`.

Gegenplan (2026-11-19): `pkgstudio/doc/module-integration-plan.md` mit G0–G7 (Pfade, `startSynaipseEmbed`, Gateway-Registrar, Mount-Handle, `--sh-*`-Set, Manifest-Loader, Aufräumen, Auth-Brücke). G0 umgesetzt (Pfade in `vite.config.ts`, `ModuleLoaders.ts`, `pkgstudio.example.json`, lokale `pkgstudio.json`), im PKG-Studio-Repo nicht committet, weil dort eigene gestagte Änderungen liegen. Mit isolierter Config (Test-Vault, Stub-Module für nppm/vtseditor) im Browser geprüft: Synaipse-Tab lädt. G1 (`startSynaipseEmbed({env})`, `/synaipse/__health`, `close()` beim Vite-Neustart), G2 (Synaipse-Tools an PKG Studios `/mcp`), G3 (`onShow`/`onHide`, `onThemeChange` → `data-shell-theme`) und G4 (volles `--sh-*`-Set; Entscheidung 2026-11-19: Synaipse übernimmt den Shell-Akzent) ebenfalls umgesetzt und geprüft, ebenfalls nicht committet. G5: PKG Studio liest `pkgstudio.module.json` (Frontend gebaut oder `source`, Backend, MCP, Env, Defaults für Label/Farbe/Theme); `vite.config.ts` und `ModuleLoaders.ts` haben keine Synaipse-Sonderfälle mehr. G6: Synaipse scrollt seinen Container selbst und hat die Mount-Option `brand: false`; damit entfallen die Synaipse-Regeln in PKG Studios `main.css`. G7: Server-Modus mit Anmeldung durch den Host: Option `principal` in `startSynaipseEmbed` (E-Mail → Account), Capability `host-principal`; PKG Studio setzt pro Modul einen festen `user` (keine eigene Anmeldung) und mountet mit `authGate: true`. Damit ist der Gegenplan G0–G7 umgesetzt.
### Status P7 (2026-11-20): abgeschlossen

| Slice | Inhalt | Stand |
|---|---|---|
| S1 C2 Dialoge | `Modal` (Rahmen mit Fokusfalle, Escape, Fokus-Rückgabe, `role="dialog"`), `confirmDialog`/`formDialog`/`promptDialog`, `toast`; alle nativen `alert`/`confirm`/`prompt` ersetzt | erledigt |
| S2 C4 Modal-Umbau | Settings, Preview, DSGVO, Floorplan, Import (dazu Token- und Summarize-Modal) auf `Modal`; Fokusringe, `aria-label` für Icon-Buttons | erledigt |
| S3 C1 Navigation | Hash-Routing (im Embed abschaltbar), Command-Palette mit allen Aktionen | erledigt |
| S4 C3 Sprache | `t(key)`, Wörterbücher de/en (Default Englisch, §13.5) | erledigt (S4a Shell, S4b Notizen/Editor, S4c Panels, S4d Konto/Dialoge) |
| S5 D2 God-Files | zuerst `Service.ts` (3970 Zeilen) | erledigt: `Service.ts`, `NotesPanel`, `CanvasRenderer`, `Graph3D`, `App.ts` |

S1: `Modal.ts` ist der eine Rahmen für kleine Dialoge im Portal-Layer: `aria-modal`, Titel als `aria-labelledby`, Tab/Shift+Tab bleiben im Dialog, Escape und Klick auf den Hintergrund brechen ab, danach geht der Fokus an den Auslöser zurück (wenn der noch sichtbar ist; „Delete“ im Überlaufmenü ist es nicht). Escape stoppt mit `stopImmediatePropagation`, damit darunterliegende Panels es nicht auch sehen. `Dialogs.ts`: `confirmDialog` (bei `danger` roter Knopf, Fokus auf Abbrechen), `formDialog` mit Validierung im Dialog statt Folge-`alert` (Projektname, Passwort-Wiederholung, Stunden, unauflösbarer Notiz-Link), `promptDialog` als Ein-Feld-Variante. `Toast.ts`: Stapel unten rechts, höchstens 4, Fehler 8 s mit `role="alert"`, sonst 4 s mit `role="status"`. 42 Aufrufe in 14 Dateien umgestellt; zusammengelegt wurden Passwort und Wiederholung (Admin) sowie geplante und umgesetzte Stunden (Roadmap) zu je einem Dialog. Der Link-Dialog im Canvas-Karteneditor merkt sich die Markierung, weil der Dialog den Fokus nimmt. Ein Test verhindert neue native Dialoge. Beschriftungen folgen der Sprache des jeweiligen Panels, bis S4 sie vereinheitlicht. Geprüft im Browser (isolierte Standalone-Instanz): Löschen mit Abbrechen, Escape und Bestätigen, Fokusfalle, Validierung im Projekt-Dialog mit Fokus-Rückgabe, „ungespeicherte Änderungen“ beim Notizwechsel, Toast.

S2: `openModal` kann jetzt auch große Dialoge: Größen `sm`–`full`, Layout `sections` (Kopf, scrollender Body, Fuß mit Trennlinien), ×-Knopf mit `aria-label`, Untertitel (E-Mail, Stream-Status), dekoratives Icon, `canDismiss` (Import läuft noch), Ctrl/Cmd+Enter (`onSubmitShortcut`), `setTitle`/`setFooter` für Dialoge, die neu rendern. „Oberster Dialog“ ist jetzt der letzte Backdrop im Portal, nicht der direkte Nachbar – ein Toast-Stapel dazwischen hatte sonst zwei Dialoge gleichzeitig auf Escape reagieren lassen. Die Fokusfalle überspringt unsichtbare Elemente. Umgezogen: Settings (Tabs als `tablist`/`tab`/`tabpanel` mit Pfeiltasten), DSGVO-Vorschau, DSGVO-Marker, Grundriss, ChatGPT-Import (Dropzone per Tastatur bedienbar, Zeilen fokussierbar, Fokus bleibt nach dem Neu-Rendern auf Zeile bzw. Checkbox), Token-Anzeige, Zusammenfassung. Sieben eigene Overlay-/Backdrop-Varianten mit z-index 110–1001 sind aus `Styles.css` raus. Fokusring: `:where(button, a, [role=button|tab|menuitem|option], [tabindex], checkbox, radio):focus-visible` mit Akzent-Outline, null Spezifität, damit eigene Fokusstile (`.btn`-Glow, Input-Rahmen) bleiben. Icon-Knöpfe in Roadmap, Benchmarks, Verlauf und Editor-Toolbar haben `aria-label`; ein Test findet `el('button')` mit reinem Glyph-Text ohne `aria-label`. Der CSS-Scope-Test trennt Selektorlisten jetzt nur an Kommas auf oberster Ebene. Geprüft im Browser (isolierte Instanz, Vite-Dev für Settings/Preview/Token): alle sieben Dialoge mit Rolle, Titel, Escape, Fokus-Rückgabe; Import-Liste mit Test-ZIP; DSGVO-Validierung und Ctrl+Enter; Escape im verschachtelten Bestätigungsdialog schließt nur diesen. Offen und unabhängig von S2: Der mdfloor-Editor im Grundriss-Dialog hat keine Layout-Styles (mdfloor liefert kein CSS für `.mdfloor-editor`, Synaipse auch nicht), Eingabe und Fläche liegen daher gestaucht untereinander.

S3: `Router.ts` (rein, getestet) liest und schreibt `#/notes/<pfad>`, `#/graph?focus=<id>`, `#/roadmap/<projekt>` und `#/<tab>`; ein Tab-Name oder eine Note-ID wie vor den Routen geht weiter. Mount-Option `routing: 'hash' | 'none'` (Standard `none`, Standalone `hash`) und `onRouteChange` für den Host; `handle.navigate()` liefert jetzt ein Promise. Jede Ansichtsänderung läuft über `App.go()`: Zwischenschritte (Tab wechseln, Note laden) landen nicht in der History, das Ergebnis genau einmal. Lehnt der Nutzer ab (ungespeicherte Änderungen behalten), wird die URL auf die tatsächliche Ansicht zurückgesetzt und der Host erfährt das ebenfalls. `NotesPanel` meldet die offene Note, `RoadmapPanel` das gezeigte Projekt (`selectProject`, `newProject`, `newStep`). Befehlspalette: Befehle kommen aus der App – alle 11 Tabs, Neue Note, Suche, Import, Theme, Aktivitätslog, Graph 2D/3D, Roadmap-Projekt und -Schritt, Tastenkürzel, Link kopieren (nur mit Hash-Routing), Kontoeinstellungen (nur mit Konto); Suche nach allen Wörtern in Titel, Gruppe und Stichwörtern; bei Eingabe stehen Befehle vor Notes. Palette als ARIA-Combobox mit `aria-activedescendant`, Fokus zurück beim Schließen. Ctrl+K-Konflikt gelöst: Ctrl+K gehört der Palette, außer im Editor (Link einfügen, `defaultPrevented`) und über offenen Dialogen; die Suche hat jetzt `/`. Neu: `?` öffnet die Tastenkürzel-Übersicht (`Shortcuts.ts`), nicht beim Tippen. Tab-Knöpfe tragen `aria-current="page"`. Reindex fehlt in der Palette, weil es keinen Endpoint dafür gibt. Geprüft im Browser (isolierte Instanz): Deep-Links auf Note, Graph mit Fokus und Roadmap-Projekt, auch nach Reload; Back/Forward über Tabs, Projektwechsel und Fokus; Ctrl+K im Editor und über Dialogen; `/`, `?`; Palette-Befehle Theme, neues Projekt, neuer Schritt; Abbrechen und Verwerfen bei ungespeicherten Änderungen. Der Embed-Fall (`routing: 'none'`) ist nur über den Code abgedeckt, nicht im Browser.

S4a: `I18n.ts` ohne Bibliothek. Jedes Modul definiert seine englischen Texte im Code unter einem Namensraum (`defineMessages('topbar', {...})`); das zurückgegebene `t` liest die Sprache bei jedem Aufruf. `{name}` wird ersetzt, `one|other` ist ein Pluralpaar (Intl.PluralRules über `count`). Die deutschen Tabellen stehen gesammelt in `I18nDe.ts`, einem eigenen Chunk, der nur bei Deutsch geladen wird: mit beiden Sprachen im Start-Bundle wären es 264 KB gewesen (Budget 260), so sind es 259 KB. Fehlt ein deutscher Text, gilt der englische. Sprache: Mount-Option `locale`, sonst gespeicherte Wahl (`synaipse.locale`), sonst Englisch; `lang` steht am Container. Umschalter „EN/DE“ in der Kopfleiste und Palettenbefehl; ein Wechsel baut die App auf der aktuellen Route neu auf, der Embed-Handle hat `setLocale`/`getLocale`. Übersetzt: Kopfleiste, Tabs, Suche, Palette und ihre Befehle, Tastenübersicht, Login, Einstellungen, Dialog-Standardknöpfe, Toast, Tag-Leiste und Tag-Picker, Aktivitätslog, Freigaben, Graph-Status (2D/3D/Tab), Meldungen in `App.ts`; Datum und Zahlen über `formatDateTime`/`formatNumber`. `test/i18n.test.ts` prüft, dass jede englische Tabelle eine deutsche mit denselben Schlüsseln, Platzhaltern und Pluralformen hat (und umgekehrt), und dass die umgestellten Module keine festen UI-Texte mehr enthalten; jede weitere Scheibe trägt ihre Dateien dort ein. Geprüft im Browser (isolierte Instanz): Englisch als Default ohne deutschen Chunk, Wechsel nach Deutsch auf `#/graph` mit Route, `lang` und Graph-Status, Wahl übersteht Reload, Rückwechsel über die Palette.

S4b: Notizbereich und Editor übersetzt: Seitenleiste (Filter, Gruppierung, Zähler mit Plural, Zeit-Gruppen „Heute“ bis „Früher“, deren Schlüssel englisch bleiben, damit eingeklappte Gruppen erhalten bleiben), Notiz-Toolbar und Überlaufmenü, Links-Blöcke, Inhaltsverzeichnis, Editor samt Formatierungsleiste und Entwurfs-Wiederherstellung (`formatDraftAge`), Verlauf, Zusammenfassen, DSGVO-Vorschau (war deutsch, jetzt beide Sprachen) und die Meldungen der Markdown-Vorschau. Die englischen Tabellen kosteten 3 KB mehr als die alten Inline-Texte und sprengten das Start-Budget (262,8 KB); deshalb lädt `NotesPanel` den Editor erst beim Bearbeiten (eigener Chunk, Schutz gegen Notizwechsel während des Ladens). Start-Bundle jetzt 236,9 KB. Der Wächter-Test erkennt zusätzlich `toastError` und bloße Text-Kinder. Geprüft im Browser auf Deutsch: Seitenleiste, Ansicht, Editor (Chunk lädt erst beim Klick), Dialog „Ungespeicherte Änderungen“, Entwurfspunkt, Zeit-Gruppen, Überlaufmenü, Verlauf. Noch englisch im Notizbereich: der lokale Graph (S4d).

S4c: die Tab-Panels übersetzt: Roadmap, Jobs (Provider-Formulare, Gitea-Status als übersetzte Optionen bei gleichen API-Werten), Benchmarks, Chat mit Seitenleiste, Inbox, Aktivität, Audit, Canvas (Panel, untere Leiste, Karten, Karten-Editor, Platzhalter für Gruppen- und Kantenbeschriftung). Roadmap, Benchmarks, Chat und Inbox waren bisher deutsch und haben jetzt englische Grundtexte; Zahlen und Datumsangaben, die fest auf `de-DE` standen, folgen der UI-Sprache. Bewusst nicht übersetzt: Daten (Kartentexte, Schritt-Titel), Pfade wie `Boards`, Texte, die in Notizen oder an das LLM gehen (Chat-Kontext-Präfix, `[stopped]`), Beispielwerte in Platzhaltern. Die Umstellung lief parallel in drei Agenten mit getrennten Dateien; die deutschen Tabellen wurden danach in `I18nDe.ts` zusammengeführt. Der Wächter-Test prüft jetzt den Text selbst (`isText`: Wörter ja, Bezeichner mit `_`/Ziffern/CamelCase, Pfade, URLs und Markennamen nein) und akzeptiert `// i18n: id` bzw. `// i18n: example` an Zeilen mit IDs oder Beispielwerten. Geprüft im Browser auf Deutsch: alle acht Panels und der Dialog „Neuer Job“; dabei fiel der Server-Bucket `<no project>` der Aktivität auf, der jetzt als „ohne Projekt“ erscheint.

S4d: Konto und Dialoge: Token- und Admin-Verwaltung, Login-Fehler, DSGVO-Marker-Dialog (Kategorien jetzt als Funktion, Marker-Syntax unverändert), Import- und ChatGPT-Import-Dialog (Ergebniszeile als ganze Sätze statt Stückwerk), Grundriss-Dialog (Vorlage geprüft zeichengleich, ihr deutscher Inhalt ist Notizinhalt und bleibt), lokaler Graph, „Dazu fragen“ an der Textauswahl, Cluster-Titel im 2D-Graph. Bewusst offen: die englischen Fallback-Fehlertexte in `Auth.ts` (`listTokens failed` usw.), die nur bei Server-Antworten ohne JSON erscheinen. Damit ist die ganze Oberfläche zweisprachig; der Wächter-Test deckt 53 Module ab. Start-Bundle 241 KB. Geprüft im Browser auf Deutsch: lokaler Graph, Import-Dialog, DSGVO-Dialog aus dem Editor.

S5 (`Service.ts`): `SynaipseService` ist jetzt eine Fassade (936 Zeilen, davon Verdrahtung, Start/Stop, Watcher und die kleinen vault-nativen Teile Canvas, Roadmap, Benchmarks, Assets, Consent); die öffentliche API ist unverändert, kein Aufrufer musste angepasst werden. Die Teile liegen in `packages/service/src/Service/`: `NoteCore` (Note-Adapter, Volltext- und Vektorindex, Embedding-Buchhaltung, Start-Indizierung, Batch, Topologie-Caches und -Listener, Watcher-Abgleich), `NoteWriter` (gescopte und ungescopte Writes, Write-Guards mit Pfad-Lock, Deletes, `updateNote`, `linkNote`, `writeRaw` für Compile/Relink/Clip/Import), `ProjectScope`, `SearchService` (Signale, RRF, Rerank, Wissensstand, Duplikate), `GraphService` (lokaler Graph, Layout mit Stale-while-revalidate, `related`, `suggestLinks`), `MemoryService` (Session-Log, remember, prime, todos, Decay), `InboxService`, `LlmService` (Chat, Vorschau, Summarize, Compile, Relink, Research, DSGVO-Schichten 2/3), `AuditRecorder` (Schicht 4), `ChatSessions`, `HistoryService`, `ImportService`, dazu `Types.ts` (re-exportiert aus `Service.ts`) und `Util.ts`. Die Layout-Neuberechnung hängt als interner Hook am Kern und läuft vor den öffentlichen Topologie-Listenern, wie vorher. Statt des geplanten `ChatService`/`PrivacyService`-Paars gibt es `LlmService` plus `AuditRecorder`, weil die Privacy-Prüfung nur auf dem Weg zum LLM gebraucht wird. Geprüft: 1340 Tests grün, Lint sauber, Eval unverändert (hit@1 0,83, MRR 0,89, Prime 824 Tokens), Smoke-Test gegen eine isolierte Instanz (Start, Suche, Schreiben mit Commit, Graph und Layout, extern angelegte Datei über den Watcher, Löschen, Activity).

S5 (`NotesPanel.ts`, 1844 → 499 Zeilen): `NotesPanel` koordiniert nur noch offene Note, Viewer und Editor. Ausgelagert: `NotesTree` (rein: Ordnerbaum, Tag- und Zeit-Gruppen, Zeilen-Layout der virtuellen Liste, Binärsuche; neu getestet in `test/notesTree.test.ts`), `NotesSidebar` (Filter, Gruppierung, Anlege-Zeile, virtuelle Liste, Entwurfs-Marker, Breiten-Griff), `NoteToc` (Gliederung mit Scroll-Spy, Klick-Pin, Aufleuchten), `NoteToolbar` (Breadcrumb, Kopf mit Aktionen, `OverflowMenu`, Tags), `NoteLinks` („Linked from“/„Links to“), `SelectionAsk` („Ask about this“) und `SummarizeDialog`. Die Dateien liegen flach in `src/`, weil die Guard-Tests (native Dialoge, `aria-label`) nur dieses Verzeichnis lesen. Verhalten unverändert; einzige Bereinigung: ein nie erreichter Rückfallzweig im Summarize-Dialog ist entfallen. Geprüft im Browser (isolierte Instanz): Deep-Link, Baum mit aktiver Note, Filter, Tag-Gruppen, Ein-/Ausklappen, Scrollen der virtuellen Liste, Gliederung mit Klick, Overflow-Menü mit Escape, Note aus unaufgelöstem Wikilink anlegen (Ordner der offenen Note), Bearbeiten und Speichern, Rückverweis, Wikilink-Navigation und Zurück, Verlauf, „+ New“ und „+“ am Ordner, „Ask about this“, Löschen über den Bestätigungsdialog; keine Konsolenfehler.

S5 (`CanvasRenderer.ts`, 2050 → 925 Zeilen): `CanvasRenderer` hält nur noch Dokument, Auswahl und die Zeiger-/Tastatur-Interaktion. Ausgelagert: `CanvasGeometry` (rein: Raster, Farben, Bezier-Routing, Anker, Bounds, Überlappung, `nodesInsideGroup` sowie alle unveränderlichen Dokument-Operationen wie Farbe, Pfeile, Labels, Löschen, Umhängen), `CanvasCamera` (Pan/Zoom/Fit als reiner Zustand, Vorstufe für die jsNGraph-Kamera aus P10 S6), `CanvasHistory` (Undo/Redo mit structuredClone-Snapshots), `CanvasCards` (Karten und Gruppenrahmen), `CanvasEdges` (SVG-Kanten, Label-Pille, Endpunkt-Griffe, Entwurfslinie), `CanvasBottomBar` (kontextuelle Leiste) und `CanvasEditors` (Text-Modal, Label-Eingaben). Statt eines eigenen `CanvasSelection` bleibt die Auswahl im Renderer, weil sie eng an die Zeiger-Logik gebunden ist. `nodesInsideGroup` wird aus `CanvasRenderer` re-exportiert. Neu getestet in `test/canvasGeometry.test.ts` (Geometrie, Dokument-Operationen, Historie, Kamera). Geprüft im Browser (isolierte Instanz): Darstellung mit Farbe, Kante, Label und Gruppe, Gruppen-Drag mit Kind, Mehrfachauswahl per Shift mit gemeinsamem Drag, Kante wählen, Pfeil- und Farbwechsel, Undo/Redo, Entf plus Undo, neue Karte per Doppelklick mit Text-Modal, Kanten- und Gruppen-Label, Kante per Anker ziehen und per Griff umhängen, Pan; alles gespeichert, keine Konsolenfehler. Gefunden, älter als der Umbau: ein Doppelklick auf Gruppenrahmen und Karten kommt wegen der Pointer-Capture am Viewport an und legt eine neue Karte an; behoben im Folge-Commit (Doppelklick prüft die Position per `elementFromPoint`). Ebenfalls älter: eine ausgewählte Gruppe lag wegen `z-index: 5` über ihren Kind-Karten; behoben, `.canvas-groups` bildet jetzt einen eigenen Stapelkontext (`isolation: isolate`).

S5 (`Graph3D.ts`, 1702 → 471 Zeilen): `GraphView3D` hält die force-graph-Instanz, Knoten- und Kanten-Records, Hover-Zustand und die Zeiger-Logik und leitet jeden Renderer-Aufruf an das aktive Render-Tier weiter. Ausgelagert: `Graph3DModel` (rein: Records, Positions-Snapshot, Adjazenz, Hover-Highlight, Link-Farbe, Heat-Stufe), `Graph3DRich` (eine Kugel pro Knoten: Geometrie-Cache, Heat, Abdimmen, Puls-Animation), `Graph3DLean` (InstancedMesh, gebündelte Kanten, eigenes Picking und Tooltip), `Graph3DEffects` (Spuren, Konzentrations-Welle, Kameraflug und Orbit), `Graph3DScene` (Tag-Hüllen, Raumgitter, Bloom, Partikel) und `Graph3DCluster` (Tag-Anker und Cluster-Kraft; im Plan als `ClusterForce` geführt). Alle Module hängen nur an `Graph3D` und bleiben damit im Lazy-Chunk; das Initial-Bundle ist unverändert (252,7 KB). Neu getestet in `test/graph3dModel.test.ts` (Records und Positions-Vorrang, Adjazenz, Highlight, Link-Farbe, Heat, Tag-Anker, Cluster-Kraft). Geprüft im Browser mit zwei erzeugten Vaults: 60 Notizen (Rich-Tier: Kugeln, Kanten, Hüllen mit Labels, Raumgitter, Cluster, Hover mit Abdimmen, Klick mit Kameraflug und Öffnen der Notiz, Puls und Orbit per `POST /api/events`, Welle per Such-Top-Treffer, Hüllen und Gitter aus- und wieder einschalten) und 1300 Notizen (Lean-Tier: Instancing, Picking mit Tooltip und Abdimmen, Klick öffnet die Notiz); Positionen werden gespeichert, keine Konsolenfehler. Hinweis zum Testen: Der in den Web-Server eingebettete MCP-Endpunkt veröffentlicht keine Events (`eventsUrl: null`), Graph-Effekte lassen sich dort nur über `POST /api/events` auslösen.

S5 (`App.ts`, 1053 → 471 Zeilen): `App` ist nur noch die Shell: aktueller Tab, `go()`/Navigation, Lazy-Panels und die Verdrahtung des Event-Streams. Die Tab-Registry gab es schon (`Tabs.ts`, S3). Ausgelagert: `Topbar` (Marke, Tab-Knöpfe, Badges, Import, Theme, Activity, Konto), `RouteSync` (Hash und Host-Route, im Plan als `Navigation` geführt), `AppCommands` (Palette-Befehle als reine Funktion über die Aktionen der App), `VaultStore` (Notizliste, Graph, Versionen und die Delta-Anwendung mit Ergebnis `notesChanged`/`graphChanged`/`reload`; die Datenquelle wird injiziert), `GraphPrefs` (die neun gespeicherten Graph-Einstellungen sowie reine Regeln für effektiven Modus, Größenhinweis und Tag-Liste) und `GraphTab` (Ansicht 2D/3D, TagBar, Heat, Puls/Spur/Fokus aus MCP-Events; im Plan als `GlobalEvents` gedacht). Neu getestet in `test/appParts.test.ts` (Deltas in Reihenfolge, Versionslücke, leeres Delta, Graph-Versionsabweichung, `dropGraph`, Modus-Schwellen, Tag-Liste, Palette-Befehle). Initial-Bundle 253,0 KB (+0,3 KB). Geprüft im Browser (isolierte Instanz, 60 Notizen): Deep-Link auf eine Notiz, Tab-Wechsel mit `aria-current`, 2D-Graph mit TagBar, neue Notiz per API kommt als Delta ohne neuen Graph-Abruf an (auch wenn der Graph-Tab gerade nicht sichtbar ist), Activity-Badge bei geschlossenem Log, Theme-Toggle, `?`-Übersicht, Palette „switch to 3D“, Zurück/Vorwärts, Tag-Filter, `#/graph?focus=` bleibt in der URL; keine Konsolenfehler. Nicht im Browser geprüft: der Vollabgleich nach `graph-reset` bzw. Reconnect (Code unverändert übernommen) und der eingebettete Modus ohne Hash-Routing.

## 3. Säule A: Performance und Skalierung (Backend)

Ziel-KPIs: **Write p95 < 30 ms** bei 50k Notes (ohne Embedding). **Kein Event-Loop-Stall > 50 ms**. Kaltstart mit warmem Cache bei 50k Notes **< 5 s**.

### A1. Inkrementeller Write-Pfad *(hoch)*
- `Vault.rebuildBacklinks()` läuft bei *jedem* Write, Delete und externen Change über den ganzen Vault (`Vault.ts:90,125,148,160,246`) und nutzt `includes` auf Arrays (`:309`). Das inkrementelle `indexNote`/`unindexNote` aus dem MariaDB-Adapter wird in eine gemeinsame Klasse **`LinkIndex`** (in `core` oder `vault`) überführt, die beide Adapter nutzen. Datenstrukturen sind `Set`s.
- Persistente Indizes **Titel/Alias → ID** und **Tag → IDs**, inkrementell gepflegt. Damit verschwinden die O(N)-Rescans in `related()` (`Service.ts:2591`), `appendSessionLog` (`:2111`), `prime()` (`:2921`), `todos()` (`:2874`) sowie `listRoadmaps` und `listBenchmarks`.
- **Bulk-Write-API** `service.batch(async tx => …)`: Backlinks, Cache-Flush, ngit-Commit, Layout-Invalidierung und SSE-Event laufen *einmal* am Ende. Crawler, Import und `JobManager` nutzen sie. Heute ist ein Crawl O(M·N).

### A2. Persistenz der Sidecars *(hoch)*
- `HashCache` schreibt bei jedem Write und jedem Such-Treffer (`touch`) das ganze JSON (`Cache.ts:218`). Ersatz: **`node:sqlite`** (in Node 22 eingebaut, keine native Dependency) als `<vault>/.synaipse/state.db` mit den Tabellen `entries`, `access`, `audit`, `jobs` und `query_cache`. Migration aus dem JSON beim ersten Start.
- `touchAccess` nur bei *gelesenen* Notes, nicht bei jedem Such-Hit (`Service.ts:570`). Das verbessert auch das `stale`-Signal.
- Das Audit-Log (`AuditLog.ts`) wandert in dieselbe DB: Tail-Reads, Count per Index, Rotation per Retention-Setting.

### A3. Schwere Arbeit raus aus dem Event-Loop *(hoch)*
- **Louvain und Layout** (`Communities.ts`, `Layout.ts`) laufen in einem `worker_threads`-Worker. Bis das neue Layout fertig ist, wird das alte ausgeliefert (*stale-while-revalidate*), Neuberechnung debounced.
- **`suggestLinks`** (`Service.ts:2736-2867`: N sequentielle Embed- und Qdrant-Calls plus O(N²) Tag-Paare) wird ein Hintergrund-Job mit Ergebnis-Cache. Vektoren kommen aus Qdrant (`recommend`/`query`) statt neu embedded zu werden. Tag-Paare laufen über den Tag-Index.
- **HF-Embedder und Reranker** (`@huggingface/transformers`) laufen in einem Worker-Pool statt im Main-Thread.

### A4. Retrieval-Effizienz *(mittel)*
- Diff-Embedding auf Chunk-Ebene: Jeder Chunk wird gehasht, nur geänderte Chunks werden embedded. Das betrifft vor allem die täglich wachsenden Session-Logs (`Pipeline.ts:94`).
- Qdrant: Umstieg von der deprecated `search`- auf die **`query`-API** mit `group_by: noteId`, Payload-Selector und serverseitigen Projekt- und Pfad-Filtern. Löst die Duplikate im Semantic-only-Modus (`Qdrant.ts:255-262`).
- LRU-Cache für Query-Embeddings, Schlüssel (Modell, Text). Wird in SQLite persistiert.
- `Vault.load` mit begrenzter Parallelität (ca. 32) statt seriellem `readFile` + `stat` (`Vault.ts:86`).
- Der Watcher ignoriert `.ngit/` und `.synaipse*/` (`Watcher.ts:22`).
- Speicher: Note-Content nicht dreifach halten (Note, Index-Snippets, DB-Snapshot). Der Body wird lazy aus Datei oder DB geladen, im RAM liegen nur Metadaten und Index.

### A5. HTTP-API *(mittel)*
- `routes.ts` (1446 Zeilen, if-Kette) wird ein kleiner **Router-Table** mit Schema-Validierung (VTS ist schon im Stack) und zentralem Error-Mapping. Die Routen werden in Dateien pro Domäne aufgeteilt: `NotesRoutes`, `GraphRoutes`, `SearchRoutes`, `RoadmapRoutes` usw.
- Ein gemeinsames `readJson` mit Byte-Limit und 413-Antwort. Heute gibt es vier Kopien ohne Limit.
- **Cursor-Pagination** für `/api/notes`, `/api/activity`, `/api/audit`. Limits clampen (`/api/search` NaN, `routes.ts:1409`).
- **ETag/304** und vorkomprimierte Buffer für `/api/graph` und `/api/graph/layout`. Der `hash` ist schon vorhanden, wird aber heute bei jedem Request neu gzippt.
- Graph-Deltas per SSE (`{added, removed, changed}`) statt Full-Reload nach jedem Write (`App.ts:399-416`).
- `JobManager`: Concurrency 1 pro Job-Typ, Zustand in SQLite persistiert, nutzt die Bulk-Write-API.

### A6. Server-Mode skalierbar *(mittel, nach Phase 0)*
- Access-Journal periodisch per Multi-Row-`INSERT … ON DUPLICATE KEY` flushen. Heute geschieht das nur bei start/stop und einzeln pro Zeile.
- Versions-Spalte und Change-Notification, damit mehrere Prozesse ihren In-Memory-Snapshot invalidieren können.
- Den ungenutzten FULLTEXT-Index entweder nutzen (als BM25-Fallback) oder entfernen.
- History und Snapshot auch im Server-Mode (Write und Delete ignorieren heute `ctx`).

### A7. Benchmark-Gate
- `scripts/bench-scale.mjs` wird ein CI-Job mit Fixtures für 10k und 50k Notes. Gemessen werden Write p95, Search p95, Kaltstart, Layout-Zeit und RSS. Die Ergebnisse landen im vorhandenen Benchmark-Feature (`synaipse_benchmark_add`). Regressionen über 20 % lassen den Job fehlschlagen.

---

## 4. Säule B: Nutzbarkeit für LLMs (MCP)

Ziel-KPIs: Tool-Liste **< 3k Tokens** (heute ca. 6k). Typische Write-Antwort **< 150 Tokens** (heute die ganze Note). `prime` bleibt **< 2k Tokens**. Null Pflicht-Einträge in `CLAUDE.md`.

### B1. Protokoll modernisieren *(hoch)*
- SDK auf `^1.29` anheben. Umstieg auf `McpServer.registerTool` mit Schemas (VTS → JSON Schema oder zod). Daraus folgt automatisch:
  - **`instructions`** im Initialize, mit dem Arbeitsprotokoll: zuerst `prime`, vor dem Schreiben suchen, Ordnerkonvention, wann `remember`, `write_note` oder `log_session`.
  - **Tool-Annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`) plus `title`. Sie werden aus der vorhandenen ACL-Tabelle generiert (`Tools.ts:223-250`), damit es nur *eine* Quelle gibt.
  - **`outputSchema` und `structuredContent`** statt pretty-printed JSON im Text. Kompaktes JSON spart dabei schon 20–30 % Whitespace.
  - `resource_link` statt eingebetteter Note-Inhalte, wo der Client nachladen kann.
- `Tools.ts` aufteilen in `Tools/Notes.ts`, `Tools/Search.ts`, `Tools/Graph.ts`, `Tools/Roadmap.ts`, `Tools/Benchmark.ts` und `Tools/Admin.ts`.
- Unbekanntes Tool als `isError`-Ergebnis statt Protokollfehler. Ungültige Enums werden abgelehnt statt still durch `hybrid` ersetzt (`Tools.ts:190`).
- Fehlertexte mit Hinweis: „Note nicht gefunden – meintest du `Memory/x/foo.md` (Titel-Match)?“. `read_note` akzeptiert Titel *oder* Pfad. Die Template-Konvention ruft heute per Titel auf und scheitert daran.

### B2. Tool-Set konsolidieren *(hoch)*
Aus 36 Tools werden ca. 22, ohne Funktion zu verlieren:

| Neu | Ersetzt |
|---|---|
| `synaipse_list {prefix, tag, sort: mtime\|title, limit, cursor}` | `list_notes`, `recent`, `notes_by_tag` |
| `synaipse_links {id, direction: in\|out\|both, typed?}` | `backlinks`, `outgoing_links` (`related` bleibt als semantische Ähnlichkeit) |
| `synaipse_graph {center?, depth?, limit}` | `graph`, künftig **nur noch als Nachbarschaft**, nie der ganze Vault |
| `synaipse_link_note` | mit derselben Auflösung und Validierung wie `roadmap_link_note` (`NoteRef.ts`), keine toten Links mehr |
| Admin-Gruppe (`verify_history`, `snapshot_list`, `benchmark_*`) | nur sichtbar per Env-Flag oder Token-Scope. Danach `notifications/tools/list_changed` senden |

Die alten Namen bleiben eine Version lang als Aliase mit Deprecation-Hinweis bestehen.

### B3. Token-Ökonomie *(hoch)*
- Write-Tools (`write_note`, `update_note`, `edit_note`, `roadmap_*`) antworten nur mit `{id, hash, mtime, changed, warnings[]}` statt mit der vollen Note bzw. dem ganzen Step-Baum.
- `read_note {id, section?, lines?, maxChars?, fields?: ['frontmatter','body','links']}` erlaubt Teil-Lesen per Überschrift und Zeilenbereich.
- `search` mit `filters {project, tags, paths, since}` (ist in `SearchQuery` schon vorhanden) und Treffer-Anker `noteId#heading` plus Zeilenspanne.
- Global `verbosity: brief|full`, Default `brief`.
- Zeitangaben als ISO-Datum plus relativem Alter („3d“) statt Epoch-Millisekunden.
- Harte `minimum`/`maximum`-Grenzen für alle `limit`s. Enums aus Code-Konstanten (`ROADMAP_STATUSES` usw.).

### B4. Gedächtnis-Qualität *(hoch)*
- **Dedupe beim Schreiben:** `write_note` und `remember` führen eine schnelle Ähnlichkeitssuche aus und geben `possibleDuplicates[]` zurück. Zusätzlich `mode: create|overwrite|upsert` und `expectedHash` als optimistischen Lock.
- **`supersedes` und `confidence` wirken:** Notes, die von einer anderen abgelöst wurden, werden im Ranking abgewertet und in `prime` ausgeblendet. `confidence` fließt als Gewicht ein. Optional `valid_until` für Wissen mit Ablaufdatum.
- **Konsolidierung:** Prompt bzw. Tool `synaipse_consolidate_inbox {project, date?}` schlägt aus Inbox-Einträgen (`remember`) Promotionen in kuratierte Notes vor. Das LLM schreibt, Synaipse liefert Kandidaten, Cluster und Ziel-Notes. Das passt zur Kuratiert-Linie.
- **Temporale Abfragen:** `synaipse_changes {since, project}` und `synaipse_note_history {id, diff?}`. Die Service-Funktionen `noteHistory`, `noteDiff` und `getActivity` gibt es schon (`Service.ts:806-873`).

### B5. Resources, Prompts, Completions *(mittel)*
- **Resources:** `synaipse://project/{p}/primer`, `…/roadmap`, `…/convention` und `synaipse://note/{path}` als Template. Damit kann der Nutzer Notes in Claude Code per `@` erwähnen.
- **Prompts:** `session-to-vault`, `consolidate-inbox`, `record-adr`, `roadmap-review`. Sie funktionieren dann auch in Cursor und anderen Clients, nicht nur als Claude-Code-Slash-Command.
- **Completions** für Note-IDs, Tags und Projekte.
- **Elicitation** für `delete_note` (Bestätigung) und den Consent-Flow statt eines 60-s-Long-Polls (`Tools.ts:55`).
- **Progress-Notifications** für lange Operationen (semantische Scans, Reindex).
- HTTP-Sessions mit TTL und Eviction (`Server.ts:167`).

### B6. Plugin und Onboarding *(mittel)*
- Der SessionStart-Hook liefert den Primer über `hookSpecificOutput.additionalContext`, dann braucht es keinen manuellen `@`-Import in `CLAUDE.md` mehr. Die Datei-Bridge bleibt als Fallback.
- Das Plugin bringt eine `.mcp.json` (mit Projekt-Segment in der URL) und eine **Skill** „synaipse-memory“ mit dem Arbeitsprotokoll mit.
- Ein Stop-Hook stößt dezent an, ob Erkenntnisse gespeichert werden sollen. Er feuert nur, wenn in der Session Code geändert *und* nichts gespeichert wurde.
- `tool-allowlist.sh` protokolliert auch `mcp__synaipse__*`-Calls mit Note-IDs. Das ermöglicht Schritt 2 von `/synaipse-session-to-vault`.
- `install-skill.mjs` schreibt die MCP-URL mit Projekt.

### B7. Eval-Harness für LLM-Nutzbarkeit *(mittel)*
- Fester Satz an Recall-Fragen gegen einen Fixture-Vault (Vorbild ist der vorhandene `retrieval.bench.ts`). Gemessen werden MRR und Recall@5 **und** die Tokens pro beantworteter Frage. Damit wird jede Änderung an Schemas und Antwortformat messbar.

---

## 5. Säule C: Nutzbarkeit für Menschen (UX)

### C1. Navigation und Orientierung
- **URL-Routing** (Hash-basiert, im Embed-Modus abschaltbar oder an den Host delegiert): `#/notes/<path>`, `#/graph?focus=…`, `#/roadmap/<project>`. Damit funktionieren Deep-Links, Back-Button und Teilen.
- **Command-Palette als Hauptnavigation:** alle Tabs, alle Aktionen (Import, Theme, Neue Note, Reindex, Roadmap-Step anlegen) und Notes per Fuzzy-Suche. Heute bietet sie nur 3 Befehle (`CommandPalette.ts:105`). Der Ctrl+K-Konflikt zwischen Palette, Suche und Editor wird aufgelöst (`CommandPalette.ts:43`, `Search.ts:33`, `EditorToolbar.ts:247`). Neu kommt ein Shortcut-Overlay mit `?`.
- **Lokaler Graph** (Ego-Netz der offenen Note, 1–2 Hops) als Seitenleiste im Note-Viewer, gebaut mit jsNGraph `RadialLayout`. Er ist der direkteste Mehrwert des Graphen im Alltag.
- **Projekt-Switcher** als globaler Kontext (Suche, Graph und Roadmap filtern danach). Im Embed-Modus kommt das Projekt vom Host.

### C2. Feedback und Zustände
- Bausteine `Toast`, `ConfirmDialog`, `EmptyState`, `ErrorState` und `Skeleton`. Sie ersetzen ca. **44 native `alert`/`confirm`/`prompt`**-Aufrufe und die uneinheitlichen Leer-Klassen.
- Fehler nie still schlucken. `loadNotes` (`App.ts:754`) und das Laden des Graphen (`App.ts:778`) zeigen heute endlos „fetching…“.
- SSE-Verbindungsstatus in der Topbar mit Backoff-Reconnect.

### C3. Sprache
- Ein kleines `I18n.ts` mit `t(key)` und Wörterbüchern **de** und **en**, ohne Library. Heute wechseln Panels zwischen Deutsch und Englisch, teils innerhalb eines Panels. Sprache aus der Einstellung oder vom Host. `lang` im Container setzen.

### C4. Barrierefreiheit (Ziel WCAG 2.2 AA)
- Dialoge mit `role="dialog"`, `aria-modal`, Fokusfalle und Fokus-Rückgabe. Ein gemeinsamer `Modal`-Baustein für Settings, Preview, DSGVO, Floorplan und Import.
- Tabs als `role="tablist"`/`tab` mit `aria-selected` und Pfeiltasten-Navigation.
- Sichtbarer `:focus-visible`-Ring überall. Heute gibt es nur 2 Regeln.
- Icon-Buttons mit `aria-label`. Glyphen (☾ ☀ ●) durch ein kleines SVG-Icon-Set ersetzen.
- `prefers-reduced-motion` global respektieren (Pulse, Trails, Bloom, Kamerafahrten).
- Automatisierte Prüfung mit axe-core im Playwright-Smoke (siehe G3).

### C5. Kern-Workflows schärfen
- **Editor:** Split-View Edit/Preview, Wikilink-Autocomplete auch für Überschriften (`[[Note#…]]`), Backlinks-Panel unter der Note, Konfliktanzeige bei externer Änderung (Hash-Mismatch) statt stillem Überschreiben.
- **Suche:** Facetten (Projekt, Tag, Zeitraum, Typ), Treffer mit hervorgehobenem Snippet und Sprung zur Überschrift. Die `explain`-Ansicht bleibt ein Power-User-Toggle.
- **Inbox und Konsolidierung:** UI für die `remember`-Inbox mit „In Note übernehmen“ und „Verwerfen“. Gegenstück zu B4.
- **Roadmap:** Abhängigkeits-DAG-Ansicht mit jsNGraph `LayeredLayout`/`ModelView`-Granularität, ein- und ausklappbar.

---

## 6. Säule D: UI-Modernisierung und Professionalisierung

### D1. Komponenten-Fundament (Vanilla TS)
- Interface **`View`** `{element, mount(), onShow(), onHide(), destroy()}` nach dem Vorbild von `GraphRenderer`. Jedes Panel implementiert es.
- **`Disposables`-Helfer** auf Basis von `AbortController`. Alle `addEventListener`, Timer, SSE-Streams und `PersistentValue`s hängen an einem Signal. Muster wie in `GraphAtlas.ts:217-222`. Ohne das gibt es kein sauberes Unmount im Embed (siehe E1).
- **Tab-Registry** `{id, labelKey, icon, factory: () => import('./X.js')}` statt 140 Zeilen Button-Code und einer if-Kette (`App.ts:448-688`). Panels werden **lazy** beim ersten Öffnen konstruiert und importiert.
- Einen kleinen reaktiven Kern (`Signal<T>`/`computed`, ca. 100 LOC) für geteilten Zustand: aktive Note, Projekt, Theme, Verbindung. Er ersetzt die verketteten Callback-Objekte zwischen Panels.

### D2. God-Files zerlegen
| Datei | Aufteilung |
|---|---|
| `NotesPanel.ts` (1795) | `NotesSidebar`, `NoteViewer`, `SelectionAsk`, `NoteToolbar` |
| `CanvasRenderer.ts` (2050) | `CanvasCamera` (→ jsNGraph), `CanvasCards`, `CanvasEdges`, `CanvasSelection`, `CanvasHistory` |
| `Graph3D.ts` (1702) | `Graph3DScene`, `Graph3DLean` (Instancing), `Graph3DEffects`, `ClusterForce` |
| `App.ts` (960) | `Shell`, `TabRegistry`, `Navigation`, `GlobalEvents` |
| `Service.ts` (3195) | `SearchService`, `GraphService`, `MemoryService` (prime, remember, session, decay), `ChatService`, `HistoryService`, `PrivacyService`, mit `SynaipseService` als dünner Fassade |

### D3. CSS-Architektur
- `Styles.css` (7805 Zeilen) aufteilen in `Styles/Tokens.css`, `Base.css` und je eine Datei pro View, mit `@layer synaipse.tokens, synaipse.base, synaipse.components, synaipse.views`.
- **Scoping:** Alles unter `.synaipse-root`. Tokens auf `.synaipse-root[data-theme]` statt `:root`. Kein `*`, `body`, `::selection` oder `::-webkit-scrollbar` global (`Styles.css:115-140`).
- Die ca. 63 hartkodierten Hex-Farben auf Tokens umstellen. Ein Lint-Check (stylelint `color-no-hex` außerhalb der Tokens-Datei) verhindert Rückfälle.
- **Design-Tokens teilen:** Synaipse-Tokens werden auf die PKG-Studio-Tokens (`--sh-*`) gemappt, mit Fallback auf die eigenen Werte (siehe E3).
- Responsive: Topbar mit Overflow-Menü und mindestens zwei Breakpoints, weil Embed-Container schmaler sind.

### D4. Bundle und Ladezeit
Ziel: **Initial-JS < 250 KB** (heute 639 KB). **First interaction < 1 s** lokal.
- jszip, turndown, CardEditor und der Canvas-Stack, Benchmarks, Admin, Roadmap und Chat lazy laden.
- highlight.js: Core plus Sprachen bei Bedarf.
- **cytoscape (455 KB) entfernen**, ersetzt durch jsNGraph (Säule F).
- Mittelfristig @antv/infographic (808 KB) für einfache Fälle durch jsNGraph `RectCharts` ersetzen. Die vollen Templates bleiben lazy.
- `manualChunks` und ein Bundle-Budget-Check in CI (`vite build` plus Größen-Assertion).

### D5. Frontend-Performance
- Chat-Streaming: Nur die streamende Blase per rAF aktualisieren statt `renderThread()` pro Token (`ChatPanel.ts:895`). Heute wächst der Aufwand quadratisch mit der Gesprächslänge.
- Lange Listen virtualisieren (Audit, Activity, Jobs, Chat-Threads). `NotesPanel` macht das schon vor.
- Render-Loops pausieren, wenn eine View versteckt ist (`IntersectionObserver` plus `visibilitychange`). Kritisch in PKG Studio, wo Tabs nie entladen werden.

---

## 7. Säule E: Synaipse als PKG-Studio-Baustein

Heute ist Synaipse in PKG Studio ein **Sonderfall** (`vite.config.ts:93,124,324-385`). Das Interface ist dort dupliziert, das Backend kommt aus `dist/`, das Frontend aus `src/` (Versions-Skew), es gibt keinen Teardown, und ca. 110 Zeilen Host-CSS reparieren Leaks. Ziel ist ein **formaler Baustein-Vertrag**, den Synaipse als Referenzimplementierung erfüllt und den nppm und vtseditor später übernehmen.

### E1. Frontend-Vertrag
```ts
// packages/web/src/Mount.ts  (exportiert als 'synaipse/web/mount')
export interface MountOptions {
    apiBase: string;                 // z. B. '/synaipse' — für fetch, EventSource UND <img src>
    project?: string;                // vom Host vorgegeben
    theme?: 'dark' | 'light';        // initial; Updates über handle.setTheme
    locale?: 'de' | 'en';
    routing?: 'hash' | 'host' | 'none';
    onNavigate?: (route: string) => void;   // Host kann Deep-Links spiegeln
}
export interface MountHandle {
    unmount(): Promise<void>;        // stoppt SSE, Timer, rAF, Listener; entfernt DOM
    setTheme(t: 'dark' | 'light'): void;
    setProject(p: string): void;
    navigate(route: string): void;
    onShow(): void; onHide(): void;  // Host-Tab sichtbar/versteckt
}
export function mount(el: HTMLElement, opts: MountOptions): Promise<MountHandle>;
```
- **Ein `apiUrl(path)`-Helfer** für alle ca. 71 hartkodierten `/api/...`-Stellen (`Api.ts`, `Auth.ts`, `AssetUrl.ts:66`, `Events.ts:21`, `ChatPanel.ts`, `MarkdownPreview.ts`). Danach braucht PKG Studio keinen globalen `fetch`/`EventSource`-Rewrite mehr (`pkgstudio/frontend/main.ts:85`). Das löst auch das dort dokumentierte Problem, dass Polling aus Hintergrund-Tabs an das falsche Modul geht.
- Theme wird auf den **Container** gesetzt, nicht auf `document.documentElement` (`Theme.ts:72`). Das hljs-Theme wird als gescopte CSS-Regel eingebunden statt als `<style>` im `<head>`.
- Kein `location.reload()` (`Settings.ts:68`, `Main.ts:32`). Stattdessen interner Remount.
- Globale Shortcuts nur bei Fokus im Container oder per Opt-in.
- `localStorage`-Keys mit Instanz-Präfix (`synaipse:<instance>:…`).

### E2. Backend-Vertrag
- `createSynaipseEmbed(opts)` bekommt **explizite Konfiguration** (`vaultPath`, `project`, `embeddings`, `qdrant`, …) statt `.env` und mutiertem `process.env` (`pkgstudio/vite.config.ts:342`).
- `close()` schließt *alles*: `EventBroadcaster`-Clients, laufende Jobs, Worker, Watcher, SQLite (heute unvollständig, `embed.ts:166-171`). Zusätzlich `health()` und `ready: Promise<void>` statt der 503-Heuristik im Host.
- Der Typ `SynaipseEmbed` wird aus einem eigenen Entry-Point exportiert. PKG Studio importiert ihn, statt ihn zu kopieren (`vite.config.ts:348`).
- `apiHandle` liest den Body selbst robust, auch wenn der Host schon `express.json()` gemountet hat. Die Reihenfolge-Abhängigkeit (`vite.config.ts:90-96`) fällt damit weg.
- **MCP-Tools beim Host registrieren** statt eines eigenen `/synaipse/mcp`: `registerTools(registrar: McpToolRegistrar)`. Dann läuft *ein* MCP-Endpoint für ganz PKG Studio, wie in dessen Konzept „one Vite, one MCP“ vorgesehen.
- Auth-Brücke: Der Host liefert einen `principal`-Callback, Synaipse wendet seine ACL darauf an. Damit funktioniert auch der Server-Mode im Embed. Heute überspringt `mount.ts` den Login.

### E3. Gemeinsames Design-System
- Ein gemeinsames Token-Set (Farben, Abstände, Radien, Typo, Motion) mit Namespace `--pkg-*`, z. B. als kleines Paket `pkg-tokens` oder als Teil des PKG-Studio-Shells. Synaipse mappt `--syn-*` → `var(--pkg-*, <eigener Fallback>)`. Standalone sieht dadurch alles aus wie heute, eingebettet übernimmt Synaipse das Theme des Hosts.
- jsNGraph bekommt dieselben Tokens über `ThemeTokens.fromCssVars(el)` (Säule F). Graphen in allen Bausteinen sehen dann einheitlich aus.

### E4. Build und Paketierung
- `@synaipse/web` aufteilen in **`@synaipse/web-client`** (Vite, Browser-Dependencies) und **`@synaipse/web-api`** (Node). Heute zieht das Server-Image three, cytoscape und @antv mit.
- Der Embed-Frontend-Entry wird als **Library-Build** (`vite build --lib`, ESM, CSS als separate Datei) ausgeliefert. Der Host konsumiert ein konsistentes Artefakt aus `dist/` für Front- *und* Backend, damit gibt es keinen Versions-Skew mehr. Für die Entwicklung bleibt der Source-Alias optional.
- PKG-Studio-Manifest: Synaipse liefert ein `pkgstudio.module.json` (id, label, color, entries, capabilities). PKG Studio liest es, statt `MODULE_ENTRY` und `ModuleLoaders.ts` von Hand zu pflegen.

> Die Gegenseite (Generalisierung des Modul-Loaders, Entfernen der Synaipse-Sonderfälle und des CSS-Pflasters in `pkgstudio/frontend/main.css:429-540`) ist ein eigener Plan im PKG-Studio-Repo. Er hängt von E1 und E2 ab.

---

## 8. Säule F: jsNGraph als Visualisierungs-Engine

Heute hat Synaipse **drei** Graph-Engines: cytoscape (2D), 3d-force-graph/three (3D) und eine eigene Canvas-„Atlas“ mit Quadtree, LOD und Community-Aggregation (`GraphAtlas.ts`, `Quadtree.ts`). Dazu kommt ein eigener Canvas-Editor mit Kamera (`CanvasRenderer.ts`). jsNGraph hat Bausteine, die genau dazu passen (Camera in ModelView, RectBoard mit Connector-Routing, Radial- und Layered-Layout), ist aber auf Netzwerk-Monitoring zugeschnitten (O(n²)-Force, keine Kamera in NGraph, Device-Semantik, rAF-Loop ohne Ende).

**Strategie:** Was in Synaipse an Graph-Engineering steckt (Atlas, Quadtree, LOD), **wandert nach jsNGraph**. Synaipse wird dessen erster großer Konsument. PKG Studio und andere Bausteine (nornen, flyingfish) profitieren mit.

### F1. jsNGraph-Erweiterungen (im jsNGraph-Repo, je Slice mit Tests und Beispiel)

| # | Erweiterung | Herkunft / Notiz |
|---|---|---|
| J1 | **Camera** in NGraph (Pan, Zoom, Fit, `focusNode`, animierte Fahrten) | `modelview/Camera.ts` generalisieren |
| J2 | **Generischer Style-Layer**: Node- und Edge-Style aus Daten oder Callback (Farbe, Größe, Form, Icon, Label). Device-Kinds werden *ein* Preset. **Edge-Typen** (gerichtet, gestrichelt, Label, Kind: wikilink, typed, tag, semantic) | Typed Wikilinks (`supersedes`, `relates_to`, …) direkt darstellbar |
| J3 | **Quadtree** für Hit-Testing und Viewport-Culling | aus `synaipse/packages/web/src/Quadtree.ts` übernehmen |
| J4 | **LOD**: Punkte → Kanten → Labels je Zoom, Label-Kollisionsvermeidung, Community-Aggregation in Super-Nodes beim Herauszoomen | Logik aus `GraphAtlas.ts` |
| J5 | **Layout-Engine**: Barnes-Hut (O(n log n)), Alpha-Cooling, Ausführung im **Web Worker**, Modus `static` (vorberechnete Positionen vom Server) | Ersetzt die O(n²)-`ForceLayout` |
| J6 | **Cluster-Hüllen** (Convex/Concave Hull pro Community) und Community-Paletten im Theme | ersetzt `Hulls.ts` und das SVG-Overlay |
| J7 | **Interaktions-API**: `highlight(ids)`, `dimOthers`, `filter(predicate)`, `neighborhood(id, depth)`, Auswahl (Lasso, Multi), erweiterte Events (`edgeClick`, `dblclick`, `contextmenu`, `selectionChange`, `viewportChange`) | Suche → Highlight, Pinned-„Boost-Zone“ (Backlog #13) |
| J8 | **Overlays**: Minimap, Heat- und Trail-Animationen als Plugin-Hooks (`onBeforeDraw`/`onAfterDraw`) | Heat und Trails aus `Graph.ts` |
| J9 | **Idle- und Visibility-Stop**: Render-Loop nur bei Änderung oder Animation, Pause bei `hidden` | Pflicht für PKG-Studio-Tabs |
| J10 | **Theme aus CSS-Variablen** `ThemeTokens.fromCssVars(el)` | Brücke zu E3 |
| J11 | Optionaler **WebGL2-Instanced-Renderer** hinter demselben Interface, für über 50k Knoten | Erfahrung aus dem Lean-Tier von `Graph3D` (Draw-Calls 5576 → 2) |
| J12 | `RectBoard`: editierbare Karten (Drag, Resize, Seiten-Anker), Undo-Hooks | Basis für den Canvas-Tab |
| J13 | Distribution: Versions-Tags. Synaipse konsumiert per `github:stefanwerfling/jsNGraph#<tag>` (`prepare: tsup` ist vorhanden). nornen stellt vom kopierten IIFE auf eine Dependency um | Reproduzierbare Builds |

### F2. Einsatz in Synaipse

| Stufe | Synaipse-Änderung | Benötigt | Effekt |
|---|---|---|---|
| S1 | **Lokaler Graph** im Note-Viewer (RadialLayout) | J1, J2, J7, J9 | Neues Feature, risikoarm, validiert die API |
| S2 | **`GraphNGraph.ts`** als `GraphRenderer`-Implementierung. 2D-Graph von cytoscape auf jsNGraph umstellen, danach cytoscape entfernen | J1–J8 | −455 KB, keine SVG-Overlay-Schichten mehr |
| S3 | **Atlas auf jsNGraph** (Modus `static` plus LOD plus Aggregation). `GraphAtlas.ts` und `Quadtree.ts` werden ein dünner Adapter | J3, J4, J5 | Eine Engine von 1 bis 100k Knoten. Die 5k/20k-Schwellen (`App.ts:39-46`) werden zu einer LOD-Frage statt eines View-Wechsels |
| S4 | **Roadmap-DAG** mit LayeredLayout bzw. ModelView-Granularität | J2, J7 | Abhängigkeiten sichtbar, Phasen ein- und ausklappbar |
| S5 | **Benchmarks und Activity** mit `RectCharts` (Sparkline, BarStrip, Timeline, Heatmap) statt handgerollter Charts | — | Weniger Code, einheitlicher Look |
| S6 | **Canvas-Tab** auf RectBoard-Kamera und -Connector-Routing | J1, J12 | `CanvasRenderer.ts` wird deutlich kleiner |
| S7 | Infographic-Light: einfache `:::infographic`-Blöcke über RectCharts, @antv nur für komplexe Templates | Adapter DSL → Rect | Weniger Bundle |

**Bleibt bewusst:** **3D-Graph** auf three.js. jsNGraph wird nicht 3D. Graph3D wird aber in Module zerlegt (D2), und seine Instancing-Erfahrung fließt in J11 ein.

---

## 9. Säule G: Engineering-Hygiene

### G1. Tests
- Contract-Tests für beide NoteAdapter (siehe Phase 0).
- Neue Tests für `routes.ts` (per Router-Table testbar), `jobs.ts`, `Watcher.ts`, `Communities.ts`, `Layout.ts`, Qdrant-Store und Embedder (gemockt).
- `service.test.ts` (1840 Zeilen) entlang der Service-Aufteilung zerlegen.
- E2E: Embed-Ausfall → Recovery (B1/B4), Write → SSE → UI-Update.

### G2. Observability
- **pino** mit Levels und Request-IDs statt ca. 82 `stderr.write`/`console.*`. Keine geschluckten Fehler (`Cache.ts:48,70,205`).
- `/api/metrics` (Prometheus-Format): Embed-Latenz, Index-Lag, Queue-Tiefe, Event-Loop-Delay, Cache-Hit-Rate, Tokens pro MCP-Antwort.
- Die UI-Seite „System“ (Admin) zeigt dieselben Werte.

### G3. Qualitätssicherung in CI
- GitHub Actions: `lint`, `tsc --build`, `vitest`, Bench-Gate (A7), Bundle-Budget (D4), **Playwright-Smoke** (Standalone *und* Embed-Mount in einer Test-Host-Seite) mit axe-a11y-Check. Die vielen offenen „Browser-Smoke offen“ aus den letzten Sessions werden so automatisiert.

### G4. Konfiguration
- Ein typisiertes Config-Schema (VTS) mit Startup-Validierung und generierter Doku in `doc/configuration.md`. Die 8 direkten `process.env`-Zugriffe außerhalb von `core/Config.ts` werden entfernt. Die Embed-Dimension kommt vom Modell statt aus der Lookup-Tabelle (`vector/Factory.ts:10-37`).

### G5. Dependencies
- Git-Dependencies (`ngit`, `vts`, `mdfloor`, künftig `jsngraph`) auf **Tags oder Commit-SHA pinnen**.
  - Ausnahme: `jsngraph` steht bewusst **ungepinnt** in `packages/web/package.json` (Nutzer-Entscheidung 2026-11-18). Den genauen Stand hält `package-lock.json` fest.
- `@modelcontextprotocol/sdk` auf `^1.29`, `vitest` auf eine aktuelle Major-Version, Qdrant-Client auf die `query`-API.
- `gray-matter` (unmaintained, js-yaml 3) durch `yaml` plus einen schlanken Frontmatter-Splitter ersetzen. Mit Round-Trip-Tests, weil Frontmatter-Treue für Obsidian-Kompatibilität kritisch ist.

### G6. Dokumentation
- `doc/architecture.md` neu schreiben: aktuelle Packages, Server-Mode, Embed, Worker, SQLite-State, jsNGraph.
- `doc/mcp-tools.md` aus den Tool-Definitionen **generieren** (Script plus CI-Check gegen Drift). Ebenso `templates/Memory/Project/architecture/mcp-tool-set.md`.
- Neu: `doc/embedding.md` (Baustein-Vertrag E1/E2) und `doc/adr/` für die großen Entscheidungen in diesem Plan.

---

## 10. Umsetzungs-Roadmap

Jede Phase besteht aus einzeln committbaren Slices und endet grün (Tests, Lint, Bench-Gate).

| Phase | Inhalt | Abhängig von | Grobe Größe |
|---|---|---|---|
| **P0 Korrektheit** | B1–B12 plus Adapter-Contract-Tests | — | 2–3 Tage |
| **P1 Fundament** | G3 CI-Grundgerüst, G2 Logging, G5 Pinning, A2 SQLite-State, A1 `LinkIndex` und Bulk-Write | P0 | 1 Woche |
| **P2 LLM-Protokoll** | B1 (SDK, instructions, annotations, structured output), B3 Token-Ökonomie, B2 Konsolidierung mit Aliasen, B6 Hook über `additionalContext` | P0 | 1 Woche |
| **P3 Embed-Vertrag** | D1 View/Disposables/Tab-Registry, E1 `mount → MountHandle` plus `apiUrl`, D3 CSS-Scoping, E2 `close`/`ready`/explizite Config | P1 | 1–1,5 Wochen |
| **P4 Performance** | A3 Worker (Layout, suggestLinks, HF), A4 Qdrant-`query`-API und Diff-Embedding, A5 Router/ETag/Pagination/Graph-Deltas, D4 Lazy-Panels, D5 Chat-Streaming | P1 | 1,5 Wochen |
| **P5 jsNGraph I** | J1, J2, J3, J7, J9, J10, J13 → S1 Lokaler Graph | parallel zu P3/P4 | 1 Woche |
| **P6 jsNGraph II** | J4, J5, J6, J8 → S2 cytoscape raus, S3 Atlas auf jsNGraph | P5 | 1,5–2 Wochen |
| **P7 UX** | C1 Routing und Palette, C2 Toast/Confirm/States, C3 i18n, C4 a11y, D2 God-Files zerlegen | P3 | 1,5 Wochen |
| **P8 Gedächtnis-Qualität** | B4 Dedupe/supersedes/Konsolidierung/temporal, B5 Resources/Prompts/Elicitation, B7 Eval-Harness, C5 Inbox-UI | P2 | 1,5 Wochen |
| **P9 PKG-Studio-Integration** | E3 Tokens, E4 Paket-Split und Lib-Build und Manifest, MCP-Registrierung beim Host. Danach der Gegenplan im PKG-Studio-Repo | P3, P5 | 1 Woche |
| **P10 Visual-Rest** | S4 Roadmap-DAG, S5 RectCharts, S6 Canvas auf RectBoard, S7 Infographic-Light, J11 WebGL, J12 | P6 | offen |
| **P11 Server-Mode** | A6 Skalierung Server-Mode | P0, P1 | 1 Woche |

**Empfohlene Reihenfolge, wenn nur ein Strang läuft:** P0 → P2 → P1 → P3 → P5 → P4 → P7 → P6 → P8 → P9 → Rest.
Begründung: P0 behebt Datenverlust- und Sicherheitsfehler. P2 bringt den größten Nutzen pro Aufwand für die tägliche Claude-Code-Nutzung. P3 ist die Voraussetzung für einen sauberen PKG-Studio-Baustein.

---

## 11. Erfolgsmessung

| KPI | Heute | Ziel |
|---|---|---|
| MCP Tool-Liste (Tokens) | ca. 6k | < 3k |
| Write-Antwort (Tokens) | ganze Note | < 150 |
| Recall@5 im Eval-Harness | (neu messen) | +10 % ggü. Baseline bei ≤ gleichen Tokens |
| Write p95 bei 50k Notes | O(N) Backlink-Rebuild | < 30 ms |
| Event-Loop-Stall max. | Layout/Louvain synchron | < 50 ms |
| Initial-JS | 639 KB | < 250 KB |
| Graph-Engines in `web` | 3 (+ Canvas-Kamera) | 2 (jsNGraph, three) |
| Interaktiver 2D-Graph | Warnung ab 5k, aus ab 20k | flüssig (≥ 30 FPS) bis 50k mit LOD |
| Native `alert`/`confirm`/`prompt` | ca. 44 | 0 |
| Listener-Leaks nach `unmount()` | kein Unmount | 0 (Playwright-Test zählt Listener und Timer) |
| Host-CSS-Workarounds in PKG Studio | ca. 110 Zeilen | 0 |
| Doku-Drift MCP-Tools | 23/36 dokumentiert | generiert, CI-geprüft |

---

## 12. Bewusst nicht im Plan

- Kein Framework-Wechsel in `web` (React, Svelte, Lit). Das Komponenten-Fundament (D1) bleibt Vanilla TS.
- Kein 3D in jsNGraph. Der 3D-Graph bleibt auf three.js.
- Keine Auto-Capture aller Tool-Calls und kein LLM-generierter Wiki-Ingest (siehe die Backlog-Entscheidungen).
- ChromaDB und LanceDB (Backlog #11/#14) bleiben im Backlog. Mit dem SQLite-State (A2) und der Qdrant-`query`-API ist ein `VectorStore`-Port aber vorbereitet, und LanceDB wäre danach ein kleiner Slice.

## 13. Offene Entscheidungen

1. ~~**SQLite-State:** `node:sqlite` oder `better-sqlite3`?~~ Entschieden: `node:sqlite` (2026-11-18), `engines >=22.13`.
2. ~~**MCP im Embed:** Tools beim PKG-Studio-Gateway registrieren (E2) oder `/synaipse/mcp` beibehalten?~~ Entschieden (2026-11-18): beides. Synaipse liefert einen Registrar für das Gateway (Projekt fest aus der Host-Config, volle Rechte); `/synaipse/mcp` bleibt für Clients mit Projekt-URL oder Token-ACL.
3. **Tool-Konsolidierung (B2):** Wie lange bleiben die alten Tool-Namen als Aliase bestehen (eine Version oder dauerhaft)?
4. ~~**Shared Tokens (E3):** eigenes Paket `pkg-tokens` oder Teil des PKG-Studio-Shells?~~ Entschieden (2026-11-18): Teil des PKG-Studio-Shells. Synaipse liest `var(--sh-*, eigener Wert)`; das vollständige `--sh-*`-Set definiert der Gegenplan im PKG-Studio-Repo.
5. ~~**i18n-Default:** UI-Default Deutsch oder Englisch?~~ Entschieden (2026-11-20): Englisch. Deutsch per Umschalter in der Kopfleiste oder Mount-Option `locale`.
