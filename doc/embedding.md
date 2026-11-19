# Embedding Synaipse in a host

Synaipse runs standalone, but it can also be embedded as a building block
inside another application. The reference host is PKG Studio. This page is
the contract between Synaipse and a host: one call mounts the UI, one call
starts the backend, and each comes with a teardown. Nothing touches global
page or process state.

## Frontend: `mount()`

```ts
import {mount} from '@synaipse/web-client/mount';   // library build from dist/lib
import '@synaipse/web-client/mount.css';            // the one stylesheet

const handle = await mount(container, {
    apiBase: '/synaipse',   // prefixed to every fetch, EventSource and <img src>
    theme: 'dark',          // optional; default: the stored preference
    route: '#/roadmap/synaipse',   // optional; see Routes below
    onRouteChange: (route) => host.setSubPath(route)   // optional
});

handle.onHide();            // host tab hidden
handle.onShow();            // host tab visible again
await handle.navigate('#/notes/Memory/demo/note.md');
handle.setTheme('light');
handle.getTheme();          // 'light'
await handle.unmount();     // stops SSE, timers, listeners; removes DOM and overlays
```

| Option | Meaning |
|---|---|
| `apiBase` | URL prefix for the backend. All API calls go through `apiUrl()`. The host needs **no** global `window.fetch` or `EventSource` rewrite; a rewrite that only touches `/api/...` leaves the prefixed URLs alone. |
| `theme` | `'dark'` or `'light'`. The theme is set as `data-theme` on the container, never on `<html>`. |
| `route` | Initial view: a route (see below), a tab name or a note id. |
| `routing` | `'none'` (default): the page URL belongs to the host; Synaipse does not touch `location`. `'hash'`: the view lives in `location.hash`, so deep links, Back and sharing work. The standalone UI uses `'hash'`. |
| `onRouteChange` | Called with the route after every view change (tab, open note, roadmap project), and once at the end of every `navigate()`, also when the user stayed put (kept unsaved changes). A host mirrors it in its own URL and hands it back via `route` or `navigate()`. |
| `onThemeChange` | Called with the active theme once after mount and on every change (the user's toggle, `setTheme`). The host switches its shell tokens along, see below. |
| `brand` | `false` hides the Synaipse logo and name in the top bar, for a host whose tab already names it. Default `true`. |
| `authGate` | Standalone only: show the login screen in server mode. A host owns authentication and leaves it off. |

### Routes

| Route | View |
|---|---|
| `#/notes` | Notes tab |
| `#/notes/Memory/demo/note.md` | a note; each path segment URI-encoded |
| `#/graph?focus=Memory%2Fdemo%2Fnote.md` | graph, centred on a note |
| `#/roadmap/<project>` | a project's roadmap |
| `#/<tab>` | any other tab (`canvas`, `inbox`, `benchmarks`, `chat`, `jobs`, `activity`, `audit`, `consent`) |

`navigate()` and `route` also take a bare tab name (`'graph'`) or a note id (`'Memory/demo/note.md'`), as before routes existed.

What the host can rely on:

- **Scoped CSS.** Every Synaipse rule sits under `.synaipse-root`, the class that `mount()` puts on the container. Nothing styles `body`, `*`, `::selection` or scrollbars outside it. Dialogs and menus render into one `.synaipse-root.synaipse-portal` layer at the end of `<body>`. That layer is removed when the last instance unmounts.
- **Sizing.** The app fills its container (`height: 100%`) and scrolls its own overflow, so tall views (roadmap) scroll inside it. Give the container a height, for example as a flex child; the host needs no overflow rule of its own.
- **Shortcuts.** `Ctrl/Cmd+K` (command palette), `/` (search) and `?` (shortcut overview) only react while the app is visible. A hidden host tab therefore does not take them away from the host. `/` and `?` never fire while the user types in a field.
- **Lazy panels.** Every tab except Notes, Graph and Consent is imported on first open.
- **Teardown.** `unmount()` closes both SSE streams and a running chat stream. It clears every interval and animation frame and removes global listeners. A fresh `mount()` into the same container afterwards works.

Known limit: the API base and the theme are page-wide. Two Synaipse instances on one page share them, which is fine as long as they talk to one backend.

### Build artifact

`@synaipse/web-client/mount` is a library build (`npm run build:lib`, part of
`npm run build`): ESM in `packages/web-client/dist/lib`, with all dependencies
bundled, so the host needs none of them and front- and backend come from the
same `dist/`. The entry is small; lazy panels and heavy libraries (3D graph,
infographic, floor plans) are separate chunks the host's bundler loads on
demand. The CSS is not imported by the JS: import `@synaipse/web-client/mount.css`
once. Types come from `dist/src/mount.d.ts`.

For development against the sources, `@synaipse/web-client/mount/source` is the
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

Every token is optional; a host can start with a few. PKG Studio sets the
full set for light and dark, including the accent, so Synaipse takes on the
shell's look there. The focus ring and the soft
gold are derived from accent and warn, so they follow the host too. The graph
reads its colours from the same variables. Roadmap status hues, shadows and
motion stay Synaipse's own.

## Backend: `startSynaipseEmbed()`

```ts
import {startSynaipseEmbed, type SynaipseEmbedHandle} from '@synaipse/web-api/embed';

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
| Types | `SynaipseEmbed`, `SynaipseEmbedHandle`, `SynaipseHealth` and `CreateSynaipseEmbedOptions` come from `@synaipse/web-api/embed`. Don't copy them. |

`createSynaipseEmbed(options)` still exists. It waits for the start and returns the started embed; the standalone server uses it.

### Host-managed sign-in (server mode)

In server mode (MariaDB, accounts) Synaipse normally shows its own login and keeps a session cookie. A host that has its own sign-in passes `principal` instead:

```ts
startSynaipseEmbed({
    env,
    principal: (req) => {
        const user = hostSession(req);       // the host's own session lookup
        return user ? {email: user.email} : null;
    }
});
// frontend: mount(container, {apiBase: '/synaipse', authGate: true})
```

| Topic | Contract |
|---|---|
| Mapping | Called per API request. The e-mail is mapped to the Synaipse account with that e-mail. Accounts are not created on the fly: a Synaipse admin creates them (admin CLI or Admin tab). An unknown or disabled account is not signed in (`401` on the API). |
| Synaipse login | Off: `POST /api/auth/login` answers `409`, `POST /api/auth/logout` is a no-op. The session cookie is ignored, the host is the only source. |
| `/api/auth/mode` | Adds `managed: "host"`. Not signed in: `hostUser` names the host's user when there is one, so the UI can say whose account is missing. |
| Frontend | With `authGate: true` the app opens for the host's user, the account settings have no "Sign out" (the host signs out). Without an account the tab shows a notice instead of the login form. |
| MCP | Unchanged: the MCP endpoint keeps its bearer tokens, and in server mode Synaipse still registers nothing on a host gateway. |
| Local mode | `principal` is ignored with a warning (no accounts). |

The manifest declares this as capability `host-principal`.

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

## Module manifest

`pkgstudio.module.json` in the repo root describes Synaipse to PKG Studio, so
the host can read it instead of keeping `MODULE_ENTRY`, `ModuleLoaders.ts`
and the `embedEntry` in `pkgstudio.json` by hand. Paths are relative to the
repo root; the schema is `doc/pkgstudio.module.schema.json`.

| Field | Synaipse | Host use |
|---|---|---|
| `id`, `label`, `color`, `theme` | `synaipse`, `Synaipse`, `#22B8A6`, `dark` | tab, status bar, initial shell theme |
| `projectScoped` | `false` | mount once at `/synaipse`; Synaipse keeps its own project |
| `entries.frontend` | `module` + `css` (library build), `export: mount`, `source` for development, `package` | `import()` the module, import the CSS once, call the export |
| `entries.backend` | `module`, `export: startSynaipseEmbed`, `package` | start the backend, route `/synaipse/api` and `mcpPath` to the handle |
| `build` | `npm run build && npm --workspace @synaipse/web-client run build` | run when `entries.*.module` is missing or older than the sources |
| `mcpPath` | `/mcp` | Synaipse's own MCP endpoint under `/synaipse` |
| `capabilities` | `mount-handle`, `api-base`, `theme-switch`, `shell-tokens`, `backend-handle`, `health`, `mcp-endpoint`, `mcp-registrar` | what the host may call; see the schema for each |
| `config` | `envFile: .env`, `project: SYNAIPSE_PROJECT` | load the env file, set the project variable, pass both as `env` |

A test (`packages/web-api/test/manifest.test.ts`) checks the manifest against
the schema, against the package exports and against the real export names,
so it can't drift from the code.

## Migrating PKG Studio

These changes are in the host and are not done yet. Since the package split
(plan P9 S5) the paths PKG Studio has today no longer exist, so **step 0 is
required** before PKG Studio starts with the current Synaipse:

0. Paths: `pkgstudio.json` `embedEntry` → `packages/web-api/dist/server/embed.js`, `envFile` stays. `MODULE_ENTRY` (`vite.config.ts`) and `ModuleLoaders.ts` → `packages/web-client/src/mount.ts`. `mountSynaipseBackend` can stay as it is otherwise.

1. `ModuleLoaders.ts`: keep the `MountHandle` that `mount()` returns, call `onShow`/`onHide` on tab switches, and call `unmount()` on teardown.
2. `vite.config.ts`: replace `createSynaipseEmbed` with `startSynaipseEmbed` and drop the 503 wrapper. Pass the settings as `env` instead of `dotenv` plus `process.env.SYNAIPSE_PROJECT`, and import the types from `@synaipse/web-api/embed`.
3. `main.css`: the bleed guards for Synaipse (`.synaipse-root .topbar` background, `html body`) are no longer needed for Synaipse itself. `.synaipse-root > .root` keeps working because the class still exists.
4. The global `fetch`/`EventSource` rewrite is no longer needed for Synaipse. It can stay for modules that have not moved yet.
5. Frontend: import `@synaipse/web-client/mount` and `@synaipse/web-client/mount.css` instead of the alias to `packages/web/src/mount.ts`; the Synaipse entry in `MODULE_ENTRY`/`optimizeDeps` is then no longer needed. Better: read both from `pkgstudio.module.json` (see "Module manifest") for every module that has one.
6. MCP: add `synaipse.mcpRegistrar` to the registrars of `mountMcp` (see "MCP on the host gateway").
7. Theme: set the `--sh-*` tokens on `:root` and switch them in `onThemeChange` (see "Design tokens").

Still open: an auth bridge (a `principal` callback from the host) for server mode.
