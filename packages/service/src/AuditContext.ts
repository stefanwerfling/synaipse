import {AsyncLocalStorage} from 'node:async_hooks';

/**
 * Per-request audit context that travels through the async call stack so
 * the audit-log writer can attribute external LLM/embedder calls back to
 * the caller (which MCP token? which UI session?) without threading the
 * info through every service-method signature.
 *
 * Populated by request entry points (mcp-server wraps each tool.handle
 * in `auditContextStorage.run({tokenLabel: scope.label}, …)`); read by
 * `Service.recordExternalCall` / `recordExternalEmbed`. Web-UI requests
 * leave it unset — the audit entry simply omits `tokenLabel` in that
 * case, which is the right signal ("call came from a session that
 * doesn't carry a token identity").
 */

export interface AuditContext {
    /** Operator-defined label from the resolved TokenScope, or undefined when the request didn't go through MCP auth. */
    tokenLabel?: string;
    /**
     * Path-prefix scope of the calling token. Empty/undefined = unrestricted.
     * Aggregate MCP tools (search, list, graph, …) consult it via
     * {@link isPathInScope} so a path-scoped token can't read notes outside
     * its prefixes through a list/search response.
     */
    pathPrefixes?: readonly string[];
}

export const auditContextStorage = new AsyncLocalStorage<AuditContext>();

/** Return the active token label (undefined when no context is set or the context doesn't carry one). */
export const getAuditTokenLabel = (): string | undefined => {
    return auditContextStorage.getStore()?.tokenLabel;
};
/**
 * True when `id` is visible to the active request's path-prefix scope.
 * No context or an empty prefix list means unrestricted.
 */
export const isPathInScope = (id: string): boolean => {
    const prefixes = auditContextStorage.getStore()?.pathPrefixes;
    if (prefixes === undefined || prefixes.length === 0) return true;
    return prefixes.some((p) => id.startsWith(p));
};
