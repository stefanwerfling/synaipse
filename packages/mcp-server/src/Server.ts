import http from 'node:http';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import type {Config} from '@synaipse/core';
import {SynaipseService} from '@synaipse/service';
import {EventPublisher} from './EventPublisher.js';
import {buildTools, type ToolHandler, type ToolContext} from './Tools.js';
import {resolveProjectFromRequest} from './Project.js';

export type TransportMode = 'stdio' | 'http';

export interface StartServerOptions {
    eventsUrl: string | null;
    transport: TransportMode;
    httpPort: number;
    httpPath: string;
}

const buildMcpServer = (
    config: Config,
    tools: ToolHandler[],
    publisher: EventPublisher,
    ctx: ToolContext = {}
): Server => {
    const handlers = new Map(tools.map((t) => [t.definition.name, t.handle]));

    const server = new Server(
        {name: config.server.name, version: config.server.version},
        {capabilities: {tools: {}}}
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map((t) => t.definition)
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<{content: Array<{type: 'text'; text: string}>; isError?: boolean}> => {
        const handler = handlers.get(request.params.name);

        if (!handler) {
            throw new Error(`Unknown tool: ${request.params.name}`);
        }

        try {
            const outcome = await handler((request.params.arguments ?? {}) as Record<string, unknown>, ctx);

            if (outcome.event !== undefined) {
                publisher.publish({
                    tool: request.params.name,
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
    });

    return server;
};

export const startServer = async (config: Config, options: StartServerOptions): Promise<void> => {
    const service = new SynaipseService(config);
    await service.start();

    const publisher = new EventPublisher(options.eventsUrl);
    const tools = buildTools(service);

    let httpServer: http.Server | null = null;

    if (options.transport === 'http') {
        httpServer = http.createServer((req, res) => {
            if (req.url === undefined || !req.url.startsWith(options.httpPath)) {
                res.statusCode = 404;
                res.end('not found');
                return;
            }

            void (async () => {
                const transport = new StreamableHTTPServerTransport({} as never);
                const project = resolveProjectFromRequest({
                    url: req.url,
                    headers: req.headers,
                    basePath: options.httpPath
                });
                const ctx: ToolContext = project !== undefined ? {project} : {};
                const server = buildMcpServer(config, tools, publisher, ctx);

                res.on('close', () => {
                    void transport.close();
                    void server.close();
                });

                try {
                    await server.connect(transport as unknown as Transport);
                    await transport.handleRequest(req, res);
                } catch (error: unknown) {
                    process.stderr.write(`[synaipse-mcp] http error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);

                    if (!res.headersSent) {
                        res.statusCode = 500;
                        res.end('internal error');
                    }
                }
            })();
        });

        await new Promise<void>((resolve) => {
            httpServer?.listen(options.httpPort, () => resolve());
        });
    } else {
        const server = buildMcpServer(config, tools, publisher);
        const transport = new StdioServerTransport();
        await server.connect(transport);
    }

    const shutdown = (): void => {
        const finalize = (): void => {
            service.stop().finally(() => process.exit(0));
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

    process.stderr.write(
        `[synaipse-mcp] ready (transport: ${transportLabel}, vault: ${config.vaultPath}, events: ${options.eventsUrl ?? 'disabled'})\n`
    );
};