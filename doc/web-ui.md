# Web UI

The web UI ships in `@synaipse/web` — vanilla TypeScript, Vite bundler, no React.

```bash
npm run web
```

| Port           | Default | Variable        | What it serves                          |
|---|---|---|---|
| Vite dev server | 5757   | `WEB_PORT`      | The UI (open this in the browser)        |
| Node API        | 3001   | `WEB_API_PORT`  | `/api/*`, SSE event stream, vault writes |

## Features

| Area | What you can do |
|---|---|
| Notes list      | Browse, filter, jump to any note |
| Editor          | Edit Markdown, save, delete |
| Search          | `fulltext` / `semantic` / `hybrid` (UI toggle) |
| Tag cloud       | Click a tag to list its notes |
| Backlinks panel | See what links to the current note |
| Graph view      | Cytoscape graph of wikilinks (lazy-loaded chunk) |
| Live events     | SSE push when a note changes (e.g. from MCP) |
| Session log     | Inspect today's `Memory/sessions/YYYY-MM-DD.md` |

## API surface

The Node API behind the UI is also useful for scripts:

| Method | Path                       | Purpose                              |
|---|---|---|
| GET    | `/api/info`                | `{semanticEnabled, notesCount}`      |
| GET    | `/api/notes`               | Note metadata list                   |
| GET    | `/api/notes/<id>`          | Read a single note                   |
| PUT    | `/api/notes/<id>`          | Write a note                         |
| DELETE | `/api/notes/<id>`          | Delete a note                        |
| GET    | `/api/search?q=&mode=`     | Search                               |
| GET    | `/api/graph`               | Graph nodes + edges                  |
| GET    | `/api/tags`                | Tag counts                           |
| POST   | `/api/sessions/log`        | Append to session log                |
| GET    | `/api/events/stream`       | SSE stream of vault events           |
| POST   | `/api/events`              | Publish an event (used by MCP)       |

The id in `/api/notes/<id>` is the vault-relative path, URL-encoded.

## Live updates from the MCP server

When the MCP server writes a note it publishes an event to `/api/events` (see [`packages/mcp-server/src/EventPublisher.ts`](../packages/mcp-server/src/EventPublisher.ts)). The UI listens via `/api/events/stream` (SSE) and refreshes affected views without a reload.

## Production build

```bash
npm --workspace @synaipse/web run build
```

The output ends up in `packages/web/dist/`. Serve it from any static host; the Node API still needs to run for writes and events.

## Related

- [getting-started.md](getting-started.md)
- [configuration.md](configuration.md)
- [architecture.md](architecture.md)