import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {createLogger} from '@synaipse/core';
import type {SynaipseService} from '@synaipse/service';
import {NO_AUTH_SCOPE} from './Auth.js';
import {EventPublisher} from './EventPublisher.js';
import {withNoteLink} from './Resources.js';
import {createToolRunner, isToolVisible, toolCallFor, type CallExtra} from './ToolRunner.js';
import {buildTools, type BuildToolsOptions, type ToolContext, type ToolHandler} from './Tools.js';

const log = createLogger('mcp');

/**
 * Synaipse tools on a host's MCP gateway (plan P9 / E2). PKG Studio builds
 * one `McpServer` per session and hands it to every module's registrar:
 *
 *   mountMcp(app, '/mcp', [registerCoreTools, synaipseRegistrar]);
 *
 * The gateway sees no token and no project URL, so every call runs with
 * full rights (NO_AUTH_SCOPE) in the project the host configured. Clients
 * that need a per-token ACL or a per-request project keep using Synaipse's
 * own endpoint (`/synaipse/mcp`). Tools only for now: resources, prompts
 * and completions use low-level handlers that would replace the gateway's
 * own and stay on the Synaipse endpoint.
 */
export interface SynaipseRegistrarOptions {
    /** Project for every call (host config); null = no project scoping. */
    project?: string | null;
    /** Live events for the Synaipse UI (the web server's /api/events/publish). */
    eventsUrl?: string | null;
    /** Tool groups to register (default: SYNAIPSE_MCP_TOOLSETS or core). */
    toolsets?: BuildToolsOptions['toolsets'];
}

export type SynaipseRegistrar = (server: McpServer) => void;

/** Accepts anything: the tool's own handler validates (as on the Synaipse endpoint). */
const LOOSE = z.object({}).passthrough();

/**
 * The tool's JSON Schema as a zod object, which McpServer requires. The
 * gateway lists it back as JSON Schema; when a schema doesn't convert the
 * tool still registers, with a loose schema.
 */
const zodInputOf = (tool: ToolHandler): z.ZodType => {
    try {
        return z.fromJSONSchema(tool.definition.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
    } catch (error) {
        log.warn('tool schema not convertible, registered loose', {
            tool: tool.definition.name,
            error: error instanceof Error ? error.message : String(error)
        });
        return LOOSE;
    }
};

export const createSynaipseRegistrar = (service: SynaipseService, options: SynaipseRegistrarOptions = {}): SynaipseRegistrar => {
    const tools = buildTools(service, options.toolsets === undefined ? {} : {toolsets: options.toolsets})
        .filter((t) => isToolVisible(t, NO_AUTH_SCOPE));
    const byName = new Map(tools.map((t) => [t.definition.name, t]));
    const ctx: ToolContext = {project: options.project ?? null};
    const runTool = createToolRunner({tools: byName, ctx, scope: NO_AUTH_SCOPE, publisher: new EventPublisher(options.eventsUrl ?? null)});
    const inputs = new Map(tools.map((t) => [t.definition.name, zodInputOf(t)]));

    return (server) => {
        for (const tool of tools) {
            const {name, title, description, annotations} = tool.definition;
            server.registerTool(
                name,
                {
                    ...(title !== undefined ? {title} : {}),
                    ...(description !== undefined ? {description} : {}),
                    inputSchema: inputs.get(name) as z.ZodObject,
                    ...(annotations !== undefined ? {annotations} : {})
                },
                async (args: Record<string, unknown>, extra) => {
                    const progressToken = extra._meta?.progressToken;
                    const {call, done} = toolCallFor(server.server, name, progressToken, extra as unknown as CallExtra);
                    try {
                        return withNoteLink(name, await runTool(name, args, {...ctx, call}));
                    } finally {
                        done();
                    }
                }
            );
        }
    };
};
