# Embedding Synaipse in a host

Synaipse runs standalone, but it can also be embedded as a building block
inside another application. The reference host is PKG Studio. This page is
the contract between Synaipse and a host: one call mounts the UI, one call
starts the backend, and each comes with a teardown. Nothing touches global
page or process state.

## Frontend: `mount()`

```ts
import {mount} from '@synaipse/web/mount';   // library build from dist/lib
import '@synaipse/web/mount.css';            // the one stylesheet

const handle = await mount(container, {
    apiBase: '/synaipse',   // prefixed to every fetch, EventSource and <img src>
    theme: 'dark',          // optional; default: the stored preference
    route: 'graph'          // optional; a tab name or a note id
});

handle.onHide();            // host tab hidden
handle.onShow();            // host tab visible again
handle.navigate('Memory/demo/note.md');
handle.setTheme('light');
handle.getTheme();          // 'light'
await handle.unmount();     // stops SSE, timers, listeners; removes DOM and overlays
```

| Option | Meaning |
|---|---|
| `apiBase` | URL prefix for the backend. All API calls go through `apiUrl()`. The host needs **no** global `window.fetch` or `EventSource` rewrite; a rewrite that only touches `/api/...` leaves the prefixed URLs alone. |
| `theme` | `'dark'` or `'light'`. The theme is set as `data-theme` on the container, never on `<html>`. |
| `route` | Initial tab (`notes`, `graph`, `canvas`, `inbox`, `roadmap`, `benchmarks`, `chat`, `jobs`, `activity`, `audit`, `consent`) or a note id. |
| `onThemeChange` | Called with the active theme once after mount and on every change (the user's toggle, `setTheme`). The host switches its shell tokens along, see below. |
| `authGate` | Standalone only: show the login screen in server mode. A host owns authentication and leaves it off. |

What the host can rely on:

- **Scoped CSS.** Every Synaipse rule sits under `.synaipse-root`, the class that `mount()` puts on the container. Nothing styles `body`, `*`, `::selection` or scrollbars outside it. Dialogs and menus render into one `.synaipse-root.synaipse-portal` layer at the end of `<body>`. That layer is removed when the last instance unmounts.
- **Sizing.** The app fills its container (`height: 100%`). Give the container a height, for example as a flex child.
- **Shortcuts.** `Ctrl/Cmd+K` and the search shortcut only react while the app is visible. A hidden host tab therefore does not take them away from the host.
- **Lazy panels.** Every tab except Notes, Graph and Consent is imported on first open.
- **Teardown.** `unmount()` closes both SSE streams and a running chat stream. It clears every interval and animation frame and removes global listeners. A fresh `mount()` into the same container afterwards works.

Known limit: the API base and the theme are page-wide. Two Synaipse instances on one page share them, which is fine as long as they talk to one backend.

### Build artifact

`@synaipse/web/mount` is a library build (`npm run build:lib`, part of
`npm run build`): ESM in `packages/web/dist/lib`, with all dependencies
bundled, so the host needs none of them and front- and backend come from the
same `dist/`. The entry is small; lazy panels and heavy libraries (3D graph,
infographic, floor plans) are separate chunks the host's bundler loads on
demand. The CSS is not imported by the JS: import `@synaipse/web/mount.css`
once. Types come from `dist/src/mount.d.ts`.

For development against the sources, `@synaipse/web/mount/source` is the
TypeScript entry (it imports its CSS itself). It needs the host's Vite to
transform it and to resolve Synaipse's dependencies.

## Design tokens

Synaipse reads the host's shell tokens first and falls back to its own
values: `--bg-1: var(--sh-surface, #11141a)`. Standalone no `--sh-*` is set,
so nothing changes; embedded, the host's palette wins. Define the tokens on
`:root` (they inherit into the container) **for the theme Synaipse shows**:
use `onThemeChange` to switch the host palette when the user toggles the
theme, otherwise a light Synaipse would get dark borders.

| Host token | Synaipse token | Used for |
|---|---|---|
| `--sh-ground` | `--bg-0` | page background |
| `--sh-surface` | `--bg-1` | panels, cards |
| `--sh-surface-2` | `--bg-2` | inputs, hover |
| `--sh-surface-3` | `--bg-3` | pressed, selected |
| `--sh-border-soft`, `--sh-border`, `--sh-border-strong` | `--border-soft`, `--border`, `--border-strong` | lines |
| `--sh-text-strong` | `--text-0` | headings |
| `--sh-text` | `--text-1` | body text |
| `--sh-muted`, `--sh-faint` | `--text-2`, `--text-3` | secondary text |
| `--sh-accent`, `--sh-accent-hover`, `--sh-accent-press` | `--accent`, `--accent-hover`, `--accent-press` | links, primary buttons |
| `--sh-accent-soft` | `--accent-soft` | selection, soft highlight (default: accent at 14 % / 10 %) |
| `--sh-ok`, `--sh-warn`, `--sh-down` | `--green`, `--gold`, `--red` | states |
| `--sh-r-sm`, `--sh-r` | `--r-2`, `--r-3` | radii |
| `--sh-font-sans`, `--sh-font-mono` | `--font-sans`, `--font-mono` | type |

Every token is optional; a host can start with a few (PKG Studio today sets
`--sh-border`, `--sh-accent`, `--sh-accent-soft`). The focus ring and the soft
gold are derived from accent and warn, so they follow the host too. The graph
reads its colours from the same variables. Roadmap status hues, shadows and
motion stay Synaipse's own.

## Backend: `startSynaipseEmbed()`

```ts
import {startSynaipseEmbed, type SynaipseEmbedHandle} from '@synaipse/web/embed';

const synaipse: SynaipseEmbedHandle = startSynaipseEmbed({
    env: {                                   // or: config: <full Config object>
        SYNAIPSE_VAULT_PATH: '/data/vault',
        EMBEDDINGS_PROVIDER: 'none',
        SYNAIPSE_PROJECT: 'pkgstudio'
    },
    mcpBasePath: '/mcp'
});

app.use('/synaipse', (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname.startsWith(synaipse.mcpBasePath)) return synaipse.mcpHandler(req, res);
    if (url.pathname.startsWith('/api/')) return void synaipse.apiHandle(req, res, url);
    res.statusCode = 404;
    res.end();
});

await synaipse.ready;        // optional: the handlers already answer 503 + Retry-After until then
synaipse.health();           // {status: 'starting' | 'ready' | 'failed' | 'closed', …}
await synaipse.close();      // on shutdown / hot reload
```

| Topic | Contract |
|---|---|
| Configuration | `config` (a full `Config`) or `env` (an env object for `loadConfigFromEnv`). Without either, `process.env` is used. A host should pass its own and **not** mutate `process.env`. |
| Readiness | Handlers exist immediately. While starting they answer `503` with `Retry-After: 1`. After a failed start they answer `500` with the reason, and `ready` rejects. |
| Body parsing | The host may mount `express.json()` before Synaipse. A body the host has already parsed is used as-is, so the order no longer matters. |
| Teardown | `close()` stops the scheduler and aborts running jobs. It ends SSE clients and closes MCP sessions. It stops the service (watcher, state DB) and closes the storage adapters. It is idempotent, and a `close()` during startup tears down as soon as the start completes. |
| Types | `SynaipseEmbed`, `SynaipseEmbedHandle`, `SynaipseHealth` and `CreateSynaipseEmbedOptions` come from `@synaipse/web/embed`. Don't copy them. |

`createSynaipseEmbed(options)` still exists. It waits for the start and returns the started embed; the standalone server uses it.

## MCP on the host gateway

A host with its own MCP endpoint can carry the Synaipse tools there, next to
its own and other modules' tools. PKG Studio's gateway builds one `McpServer`
per session and runs every registrar on it:

```ts
mountMcp(app, '/mcp', [registerCoreTools, synaipse.mcpRegistrar]);
```

| Topic | Contract |
|---|---|
| What | Every tool of the enabled toolsets (`SYNAIPSE_MCP_TOOLSETS`, default `core`), with title, description, annotations and the input schema. Confirmation before deleting (elicitation), progress and cancellation work as on the Synaipse endpoint; writes carry a `resource_link`. |
| Rights | Full rights, in the project of the host config (`SYNAIPSE_PROJECT`). The gateway sees no token, so there is no per-token ACL. |
| Server mode | With accounts and tokens the registrar adds nothing (one warning in the log). Clients use the Synaipse endpoint with their token. |
| Startup | Sessions opened before Synaipse finished starting get no Synaipse tools; the next session has them. |
| Not on the gateway | Resources, prompts, completions and the server instructions. They use protocol handlers that would replace the gateway's own. Clients that want them use the Synaipse endpoint (`/synaipse/mcp`). |
| Schemas | `McpServer` takes zod schemas, so the JSON Schemas are converted with `z.fromJSONSchema` and listed back as JSON Schema; arguments are validated against them. A schema that does not convert registers loose (warning in the log). |

Outside the web package the same comes from `createSynaipseRegistrar(service, {project, toolsets})` in `@synaipse/mcp-server`.

## Migrating PKG Studio

These changes are in the host and are not done yet:

1. `ModuleLoaders.ts`: keep the `MountHandle` that `mount()` returns, call `onShow`/`onHide` on tab switches, and call `unmount()` on teardown.
2. `vite.config.ts`: replace `createSynaipseEmbed` with `startSynaipseEmbed` and drop the 503 wrapper. Pass the settings as `env` instead of `dotenv` plus `process.env.SYNAIPSE_PROJECT`, and import the types from `@synaipse/web/embed`.
3. `main.css`: the bleed guards for Synaipse (`.synaipse-root .topbar` background, `html body`) are no longer needed for Synaipse itself. `.synaipse-root > .root` keeps working because the class still exists.
4. The global `fetch`/`EventSource` rewrite is no longer needed for Synaipse. It can stay for modules that have not moved yet.

5. Frontend: import `@synaipse/web/mount` and `@synaipse/web/mount.css` instead of the alias to `packages/web/src/mount.ts`; the Synaipse entry in `MODULE_ENTRY`/`optimizeDeps` is then no longer needed.
6. MCP: add `synaipse.mcpRegistrar` to the registrars of `mountMcp` (see "MCP on the host gateway").
7. Theme: set the `--sh-*` tokens on `:root` and switch them in `onThemeChange` (see "Design tokens").

Still open: an auth bridge (a `principal` callback from the host) for server mode.
