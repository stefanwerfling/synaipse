import type {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {ElicitResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {createLogger} from '@synaipse/core';
import {auditContextStorage} from '@synaipse/service';
import {checkScope, type TokenScope} from './Auth.js';
import type {EventPublisher} from './EventPublisher.js';
import type {ToolCall, ToolContext, ToolHandler, ToolResponse} from './Tools.js';
import {REMOVED_TOOLS} from './Tools/Acl.js';

/**
 * The one way a Synaipse tool runs — shared by Synaipse's own MCP endpoint
 * (Server.ts) and the registrar for a host's MCP gateway (Registrar.ts),
 * so scope check, audit context, live events, confirmation and progress
 * behave the same on both.
 */

const log = createLogger('mcp');

/** While a tool runs and the client asked for progress, a notification this often (keeps request timeouts from firing). */
const PROGRESS_HEARTBEAT_MS = 5_000;
/** A confirmation the user leaves open this long counts as cancelled. */
const ELICIT_TIMEOUT_MS = 10 * 60_000;

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

/**
 * Whether a token sees a tool in tools/list: a write-restricted token
 * doesn't see write tools even though it couldn't call them anyway.
 */
export const isToolVisible = (tool: ToolHandler, scope: TokenScope): boolean => {
    if (scope.tools.length > 0 && !scope.tools.includes(tool.definition.name)) return false;
    if ((tool.mode ?? 'read') === 'write' && !scope.write) return false;
    if ((tool.mode ?? 'read') === 'read' && !scope.read) return false;
    return true;
};

export type RunTool = (name: string, args: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolResponse>;

/** One tool call with scope check, audit context and live event; errors become tool errors. */
export const createToolRunner = (deps: {
    tools: ReadonlyMap<string, ToolHandler>;
    ctx: ToolContext;
    scope: TokenScope;
    publisher: EventPublisher;
}): RunTool => async (name, args, callCtx = deps.ctx) => {
    const tool = deps.tools.get(name);

    // Tool-level error, not a protocol error: the model sees it and can
    // correct itself instead of the client aborting the turn.
    if (!tool) {
        return {
            isError: true,
            content: [{type: 'text', text: REMOVED_TOOLS[name] !== undefined
                ? `${name} was removed; use ${REMOVED_TOOLS[name]}.`
                : `Unknown tool: ${name}. Call tools/list for the available synaipse_* tools.`}]
        };
    }

    const denial = checkScope(
        deps.scope,
        {name: tool.definition.name, mode: tool.mode ?? 'read', ...(tool.unscopedOnly === true ? {unscopedOnly: true} : {})},
        resolvePathArg(tool, args)
    );
    if (denial !== null) {
        return {isError: true, content: [{type: 'text', text: `Forbidden: ${denial}`}]};
    }

    try {
        // Audit context: the service-layer audit-log writer reads the
        // active token label via AsyncLocalStorage.
        const outcome = await auditContextStorage.run(
            {tokenLabel: deps.scope.label, pathPrefixes: deps.scope.pathPrefixes},
            () => tool.handle(args, callCtx)
        );

        if (outcome.event !== undefined) {
            deps.publisher.publish({
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
        return {isError: true, content: [{type: 'text', text: `Error: ${message}`}]};
    }
};

/** The parts of an SDK request-handler `extra` a tool call uses. */
export interface CallExtra {
    requestId: string | number;
    signal: AbortSignal;
    sendNotification: (notification: {method: 'notifications/progress'; params: {progressToken: string | number; progress: number; message?: string}}) => Promise<void>;
}

/**
 * What one call can do towards the client: confirm (form elicitation, when
 * the client declared it), progress (when it sent a progressToken, plus a
 * heartbeat) and cancellation. `done()` stops the heartbeat.
 */
export const toolCallFor = (
    server: Server,
    name: string,
    progressToken: string | number | undefined,
    extra: CallExtra
): {call: ToolCall; done: () => void} => {
    let step = 0;

    // Progress values must increase; one counter for the heartbeat and the tool's own messages.
    const progress = progressToken === undefined
        ? undefined
        : (message: string): Promise<void> => extra.sendNotification({
            method: 'notifications/progress',
            params: {progressToken, progress: ++step, message}
        }).catch(() => undefined);

    // Form elicitation: an empty capability object means form (older clients).
    const elicitation = server.getClientCapabilities()?.elicitation;
    const confirm = elicitation === undefined || (elicitation.form === undefined && elicitation.url !== undefined)
        ? undefined
        : async (message: string): Promise<'accept' | 'decline' | 'cancel'> => {
            try {
                const result = await server.request(
                    {method: 'elicitation/create', params: {message, requestedSchema: {type: 'object', properties: {}}}},
                    ElicitResultSchema,
                    {relatedRequestId: extra.requestId, signal: extra.signal, timeout: ELICIT_TIMEOUT_MS}
                );
                return result.action;
            } catch (error) {
                // No answer (timeout, client error) never counts as yes.
                log.warn('elicitation failed, treated as cancel', {tool: name, error: error instanceof Error ? error.message : String(error)});
                return 'cancel';
            }
        };

    const started = Date.now();
    const heartbeat = progress === undefined
        ? undefined
        : setInterval(() => void progress(`${name} running for ${Math.round((Date.now() - started) / 1000)} s`), PROGRESS_HEARTBEAT_MS);

    return {
        call: {signal: extra.signal, ...(progress !== undefined ? {progress} : {}), ...(confirm !== undefined ? {confirm} : {})},
        done: () => {
            if (heartbeat !== undefined) clearInterval(heartbeat);
        }
    };
};
