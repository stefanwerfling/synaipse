import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createLogger} from '@synaipse/core';
import type {Config, UserStore} from '@synaipse/core';
import {auditContextStorage, NoopAssetStore, SynaipseService, type ServiceOverrides} from '@synaipse/service';
import {NoopHistory} from '@synaipse/vault';
import {EventPublisher} from './EventPublisher.js';
import {buildTools, type ToolHandler, type ToolContext, type ToolResponse} from './Tools.js';
import {buildInstructions} from './Instructions.js';
import {resolveContextFromRequest} from './Project.js';
import {checkScope, isAdminScope, isAuthConfigured, NO_AUTH_SCOPE, resolveTokenScope, type TokenScope} from './Auth.js';
import {CachedUserStore} from './CachedUserStore.js';
import {registerExtras, withNoteLink} from './Resources.js';

const log = createLogger('mcp');

const ADMIN_FLUSH_AUTH_CACHE_PATH = '/admin/flush-auth-cache';

const DEFAULT_AUTH_CACHE_TTL_MS = 60_000;

const resolveAuthCacheTtlMs = (): number => {
    const raw = process.env.SYNAIPSE_AUTH_CACHE_TTL_MS;
    if (raw === undefined || raw.trim() === '') return DEFAULT_AUTH_CACHE_TTL_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_AUTH_CACHE_TTL_MS;
    return parsed;
};

export type TransportMode = 'stdio' | 'http';

export interface StartServerOptions {
    eventsUrl: string | null;
    transport: TransportMode;
    httpPort: number;
    httpPath: string;
}

/**
 * Extract the path argument the ACL checks against. Fail-closed: when the
 * tool's schema marks its path field as required but the caller sent a
 * non-string (or nothing), return '' — which matches no prefix — so a
 * path-scoped token can't skip the prefix check by omitting the field.
 */
export const resolvePathArg = (tool: ToolHandler, args: Record<string, unknown>): string | undefined => {
    if (tool.pathArg === undefined) return undefined;
    const value = args[tool.pathArg];
    if (typeof value === 'string') return value;
    const required = (tool.definition.inputSchema as {required?: unknown}).required;
    return Array.isArray(required) && required.includes(tool.pathArg) ? '' : undefined;
};

export const buildMcpServer = (
    config: Config,
    tools: ToolHandler[],
    publisher: EventPublisher,
    project: string | null,
    ctx: ToolContext = {},
    scope: TokenScope = NO_AUTH_SCOPE,
    /** With the service: resources, prompts and completions too (plan P8 / B5). */
    service?: SynaipseService
): Server => {
    const byName = new Map(tools.map((t) => [t.definition.name, t]));

    const server = new Server(
        {name: config.server.name, title: 'Synaipse', version: config.server.version},
        {
            capabilities: service === undefined ? {tools: {}} : {tools: {}, resources: {}, prompts: {}, completions: {}},
            instructions: buildInstructions(project)
        }
    );

    // ListTools filters by tool whitelist when the scope has one set —
    // a write-restricted token shouldn't see write tools in the catalog
    // even if it wouldn't be allowed to call them. Keeps the client UI
    // honest.
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools
            .filter((t) => {
                if (t.hidden === true) return false;
                if (scope.tools.length > 0 && !scope.tools.includes(t.definition.name)) return false;
                if ((t.mode ?? 'read') === 'write' && !scope.write) return false;
                if ((t.mode ?? 'read') === 'read' && !scope.read) return false;
                return true;
            })
            .map((t) => t.definition)
    }));

    /**
     * One tool call with scope check, audit context and live event. Tool
     * calls and resource reads (which reuse the read tools) both go
     * through here, so a resource can never see more than the tool would.
     */
    const runTool = async (name: string, args: Record<string, unknown>, callCtx: ToolContext = ctx): Promise<ToolResponse> => {
        const tool = byName.get(name);

        // Tool-level error, not a protocol error: the model sees it and can
        // correct itself instead of the client aborting the turn.
        if (!tool) {
            return {
                isError: true,
                content: [{type: 'text', text: `Unknown tool: ${name}. Call tools/list for the available synaipse_* tools.`}]
            };
        }

        const denial = checkScope(
            scope,
            {name: tool.definition.name, mode: tool.mode ?? 'read', ...(tool.unscopedOnly === true ? {unscopedOnly: true} : {})},
            resolvePathArg(tool, args)
        );
        if (denial !== null) {
            return {
                isError: true,
                content: [{type: 'text', text: `Forbidden: ${denial}`}]
            };
        }

        try {
            // Audit-context: the service-layer audit-log writer reads the
            // active TokenScope.label via AsyncLocalStorage so embed/chat
            // entries get tagged with the calling MCP token without
            // threading the label through every service-method signature.
            const outcome = await auditContextStorage.run(
                {tokenLabel: scope.label, pathPrefixes: scope.pathPrefixes},
                () => tool.handle(args, callCtx)
            );

            if (outcome.event !== undefined) {
                publisher.publish({
                    tool: name,
                    kind: outcome.event.kind,
                    touched: outcome.event.touched,
                    ...(outcome.event.query !== undefined ? {query: outcome.event.query} : {}),
                    ts: Date.now()
                });
            }

            return outcome.response;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                isError: true,
                content: [{type: 'text', text: `Error: ${message}`}]
            };
        }
    };

    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ToolResponse> => {
        const response = await runTool(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>);
        return service === undefined ? response : withNoteLink(request.params.name, response);
    });

    if (service !== undefined) {
        registerExtras(server, {service, project, ctx, scope, tools: byName, runTool});
    }

    return server;
};

/**
 * Build a plain `(req, res) => void` request handler that serves the MCP
 * StreamableHTTP transport on a given basePath. Lets us mount MCP under an
 * existing http.Server (e.g. the synaipse web API) and share a single
 * SynaipseService instance instead of spawning a second process.
 *
 * Two auth modes — picked by what's in `config.server`:
 *   - **No auth** (neither `token` nor `tokens` set). Every request runs
 *     under the `NO_AUTH_SCOPE` (full admin). Localhost-dev only; a
 *     stderr WARN on startup nags the operator.
 *   - **Token-list** (`tokens: [{token, label?, read?, write?,
 *     pathPrefixes?, tools?}]`) and/or legacy single token
 *     (`token: <string>`, treated as an admin-all alias). Each request
 *     must carry `Authorization: Bearer <token>`. resolveTokenScope
 *     returns the matched scope; mismatch → 401. The scope is then
 *     enforced per tool inside `buildMcpServer` (read vs write, tool
 *     whitelist, path-prefix restriction).
 */
interface McpSessionEntry {
    transport: StreamableHTTPServerTransport;
    server: Server;
    tokenLabel: string;
}

const readSessionIdHeader = (req: http.IncomingMessage): string | undefined => {
    const raw = req.headers['mcp-session-id'];
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw) && raw.length > 0) return raw[0];
    return undefined;
};

/** The MCP Streamable-HTTP request listener plus session teardown. */
export type McpHttpHandler = http.RequestListener & {closeAll(): Promise<void>};

export const buildMcpHttpHandler = (
    config: Config,
    service: SynaipseService,
    options: {basePath: string; eventsUrl: string | null; userStore?: UserStore | null}
): McpHttpHandler => {
    const publisher = new EventPublisher(options.eventsUrl);
    const tools = buildTools(service);
    const userStore = options.userStore ?? null;
    const authConfigured = isAuthConfigured(config, userStore);

    // Streamable-HTTP is stateful: the SDK generates a session ID on
    // the client's `initialize` call and rejects subsequent tool calls
    // that either lack the `Mcp-Session-Id` header (400) or reference
    // an unknown session (404). We must therefore keep one transport +
    // Server per session across HTTP requests — a fresh transport per
    // request would always report "Server not initialized".
    const sessions = new Map<string, McpSessionEntry>();

    if (!authConfigured) {
        log.warn('no SYNAIPSE_MCP_TOKEN, server.tokens, or user store configured — HTTP endpoint is unauthenticated. '
            + 'Safe only for localhost; set auth before exposing the port to LAN / remote.');
    }

    const handler: http.RequestListener = (req, res) => {
        if (req.url === undefined || !req.url.startsWith(options.basePath)) {
            res.statusCode = 404;
            res.end('not found');
            return;
        }

        void (async () => {
            let scope: TokenScope;
            if (!authConfigured) {
                scope = NO_AUTH_SCOPE;
            } else {
                const resolved = await resolveTokenScope(req.headers.authorization, config, userStore);
                if (resolved === null) {
                    res.statusCode = 401;
                    res.setHeader('WWW-Authenticate', 'Bearer realm="synaipse-mcp"');
                    res.end('unauthorised');
                    return;
                }
                scope = resolved;
            }

            // Admin: flush the auth cache. Routed before the MCP transport
            // so cached scope verification can be evicted on demand without
            // restarting the server. Only available when a CachedUserStore
            // is wired in (mode=server with TTL>0).
            const pathOnly = (req.url ?? '').split('?')[0];
            if (pathOnly === `${options.basePath}${ADMIN_FLUSH_AUTH_CACHE_PATH}`) {
                if (req.method !== 'POST') {
                    res.statusCode = 405;
                    res.setHeader('Allow', 'POST');
                    res.end('method not allowed');
                    return;
                }

                if (!(userStore instanceof CachedUserStore)) {
                    res.statusCode = 404;
                    res.end('auth cache not active');
                    return;
                }

                if (!isAdminScope(scope)) {
                    res.statusCode = 403;
                    res.end('admin scope required (unrestricted read+write)');
                    return;
                }

                const flushed = userStore.size();
                userStore.flush();
                log.info('auth-cache flushed', {entries: flushed, token: scope.label});
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({flushed}));
                return;
            }

            const sessionId = readSessionIdHeader(req);
            const existing = sessionId !== undefined ? sessions.get(sessionId) : undefined;

            const runHandle = async (transport: StreamableHTTPServerTransport): Promise<void> => {
                try {
                    await transport.handleRequest(req, res);
                } catch (error: unknown) {
                    log.error('http request failed', {method: req.method, url: req.url, error});
                    if (!res.headersSent) {
                        res.statusCode = 500;
                        res.end('internal error');
                    }
                }
            };

            if (existing !== undefined) {
                // Bind the session to the token label that opened it —
                // otherwise a leaked session ID could be reused by any
                // other authenticated caller.
                if (existing.tokenLabel !== scope.label) {
                    res.statusCode = 403;
                    res.end('session bound to a different token');
                    return;
                }
                await runHandle(existing.transport);
                return;
            }

            if (sessionId !== undefined) {
                // Client presented a session ID we don't know about — the
                // SDK's own 404 semantics for "Session not found".
                res.statusCode = 404;
                res.end('session not found');
                return;
            }

            // No session ID header → must be an `initialize` request.
            // Build a fresh Server + transport pair, register it in the
            // session map when the SDK generates the ID, and tear it
            // down when the transport signals close.
            const ctx: ToolContext = resolveContextFromRequest({
                url: req.url ?? '/',
                headers: req.headers,
                basePath: options.basePath
            });
            const server = buildMcpServer(config, tools, publisher, service.getProject(ctx.project), ctx, scope, service);
            const tokenLabel = scope.label;

            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id: string) => {
                    sessions.set(id, {transport, server, tokenLabel});
                }
            });

            // Guard against re-entrant teardown: server.close() closes the
            // transport, which fires onclose again → infinite recursion
            // (RangeError: Maximum call stack size exceeded). Run the
            // teardown exactly once.
            let closing = false;
            transport.onclose = () => {
                if (closing) return;
                closing = true;
                const id = transport.sessionId;
                if (id !== undefined) sessions.delete(id);
                void server.close();
            };

            try {
                await server.connect(transport as unknown as Transport);
                await runHandle(transport);
            } catch (error: unknown) {
                log.error('http request failed', {method: req.method, url: req.url, error});
                if (!res.headersSent) {
                    res.statusCode = 500;
                    res.end('internal error');
                }
            }
        })();
    };

    return Object.assign(handler, {
        /** Close every open MCP session (embed close / shutdown). */
        closeAll: async (): Promise<void> => {
            const open = [...sessions.values()];
            sessions.clear();
            await Promise.allSettled(open.map((entry) => entry.server.close()));
        }
    });
};

interface OverridesResult {
    overrides: ServiceOverrides;
    userStore: UserStore | null;
    close: () => Promise<void>;
}

const buildOverrides = async (config: Config): Promise<OverridesResult> => {
    if (config.mode !== 'server') {
        return {overrides: {}, userStore: null, close: () => Promise.resolve()};
    }

    if (config.mariadb === undefined) {
        throw new Error('config.mode=server requires config.mariadb — check loadConfigFromEnv');
    }

    const {createServerAdapters} = await import('@synaipse/server-storage');
    const bundle = await createServerAdapters(config.mariadb);

    const cacheTtl = resolveAuthCacheTtlMs();
    const userStore: UserStore = cacheTtl > 0
        ? new CachedUserStore(bundle.users, cacheTtl)
        : bundle.users;

    return {
        overrides: {
            notes: bundle.notes,
            chats: bundle.chats,
            history: new NoopHistory(),
            assetStore: new NoopAssetStore(),
            skipWatcher: true
        },
        userStore,
        close: () => bundle.close()
    };
};

export const startServer = async (config: Config, options: StartServerOptions): Promise<void> => {
    const {overrides, userStore, close: closeAdapters} = await buildOverrides(config);
    if (config.mode === 'server') {
        const cacheTtl = resolveAuthCacheTtlMs();
        const cacheNote = cacheTtl > 0 ? `auth-cache TTL=${cacheTtl}ms` : 'auth-cache OFF';
        log.info('server-mode: MariaDB-backed adapters wired in', {authCache: cacheNote});
        if (config.server.tokens !== undefined && config.server.tokens.length > 0) {
            log.warn('config.server.tokens is set but mode=server — yaml tokens are ignored. '
                + 'Use `npm run user create` or `npm run user import-yaml` to populate the users table.');
        }
    }

    const service = new SynaipseService(config, overrides);
    await service.start();

    let httpServer: http.Server | null = null;

    if (options.transport === 'http') {
        const handler = buildMcpHttpHandler(config, service, {
            basePath: options.httpPath,
            eventsUrl: options.eventsUrl,
            userStore
        });

        httpServer = http.createServer(handler);

        await new Promise<void>((resolve) => {
            httpServer?.listen(options.httpPort, () => resolve());
        });
    } else {
        const publisher = new EventPublisher(options.eventsUrl);
        const tools = buildTools(service);
        const server = buildMcpServer(config, tools, publisher, service.getProject(), {}, NO_AUTH_SCOPE, service);
        const transport = new StdioServerTransport();
        await server.connect(transport);
    }

    const shutdown = (): void => {
        const finalize = (): void => {
            service.stop()
                .finally(() => closeAdapters())
                .finally(() => process.exit(0));
        };

        if (httpServer !== null) {
            httpServer.close(() => finalize());
            return;
        }

        finalize();
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    const transportLabel = options.transport === 'http'
        ? `http://localhost:${options.httpPort}${options.httpPath}`
        : 'stdio';

    log.info('ready', {transport: transportLabel, vault: config.vaultPath, events: options.eventsUrl ?? 'disabled'});
};