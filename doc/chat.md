# Local chat

Offline RAG-Chat über den Vault — kein API-Schlüssel, kein Internet, kein Cloud-LLM. Das lokale Modell läuft im Ollama-Container der eh schon für die Embeddings-Pipeline da ist.

## Setup

```bash
# in .env
SYNAIPSE_CHAT_URL=http://localhost:11434
SYNAIPSE_CHAT_MODEL=gemma3:4b
EMBEDDINGS_PROVIDER=ollama         # optional, aber nutzt sonst den existierenden Container
```

Modell ziehen:

```bash
npm run docker:up:ollama
```

Der `ollama-init` Container pulled bei diesem Profil sowohl das Embeddings-Modell (`nomic-embed-text`) als auch das Chat-Modell (`SYNAIPSE_CHAT_MODEL`, default `gemma3:4b`). Beim ersten Start zieht das ~2.5 GB Gemma 3 4B + 270 MB Embeddings runter.

## Modell-Empfehlungen

| Tag | Größe | RAM | Profil |
|---|---|---|---|
| `gemma3:4b`   | ~2.5 GB | 4 GB  | Default — schnell, läuft überall, OK Deutsch |
| `gemma3:12b`  | ~7 GB   | 12 GB | Beste Reasoning bei mittlerer RAM-Last |
| `qwen2.5:7b`  | ~4.5 GB | 8 GB  | Beste Deutsch-Qualität in der Größenklasse |
| `phi3:mini`   | ~2.3 GB | 4 GB  | Sehr schnell, simpel — gut für Tablets |

Modellwechsel: `SYNAIPSE_CHAT_MODEL=qwen2.5:7b` → Container restarten → `ollama-init` zieht es nach.

## Wie es läuft

1. User fragt im **Chat**-Tab
2. Backend macht `service.search(question, mode='hybrid', limit=8)` → Top-8 Notes
3. Baut Prompt:
   - **System**: „Antworte ausschließlich basierend auf den folgenden Notizen … Zitiere mit `[^N]`."
   - **Context**: nummerierte Liste der Notes mit Snippet
   - **User**: die Frage
4. POST `/api/chat/stream` (Ollama-Standard) → Tokens werden via Server-Sent-Events durchgereicht
5. UI rendert tokenweise + zeigt klickbare **Sources** unter der Antwort

## Web UI

Neuer Tab **Chat** neben Notes/Graph. Sieht so aus:

```
Chat with your notes                                    gemma3:4b

You: Was hab ich zu BackendCluster entschieden?

Synaipse: Du hast 2026-06-11 entschieden, die Cluster-Logik aus
der BackendApp auszulagern, weil sie zu groß wurde [^1]. Service-
Manager übernimmt die Start-Reihenfolge [^2].

Sources
  [^1] 2026-06-11-backendcluster
  [^2] architecture/service-manager
```

Quellen sind klickbar — öffnet die Note direkt im Notes-Tab.

## API

`POST /api/chat` mit JSON `{question, pathPrefix?}` → SSE-Stream von Events:

| Event | Payload |
|---|---|
| `start`  | `{sources: [...], model: "..."}` |
| `token`  | `{text: "..."}` |
| `done`   | `{totalTokens: N}` |
| `error`  | `{message: "..."}` |

Beispiel mit `curl`:

```bash
curl -N -X POST http://localhost:3001/api/chat \
  -H "content-type: application/json" \
  -d '{"question":"Was steht in meinen ADRs zu Voyage?"}'
```

`/api/info` enthält `chatEnabled` und `chatModel` für UI-Discovery.

## Hinweise

- **Project-Scope wird respektiert** über den `pathPrefix` — wenn du im UI eingeloggt bist und ein Projekt gesetzt hast, kannst du den Scope per Request setzen
- **Streaming bricht ab** wenn der User die Page schließt (AbortSignal vom HTTP-Connection-Close)
- **Kein History-Persist** in v1 — der Chat lebt nur im Browser-Tab. Wenn du das willst, sag Bescheid, dann landet's in `Memory/<project>/chats/`

## Kein Internet?

Sobald die Modelle einmal gezogen sind, läuft alles lokal:
- Embeddings (für Semantic Search): Ollama lokal
- Chat-Generierung: Ollama lokal
- Knowledge-Base: Markdown im Vault

→ Du kannst offline arbeiten.