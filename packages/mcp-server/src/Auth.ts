import {timingSafeEqual} from 'node:crypto';
import type {Config, UserRecord, UserStore} from '@synaipse/core';

/**
 * Per-token ACL. The legacy single `config.server.token` (Phase-1 MCP
 * Bearer-Auth in 43d9e19) is still supported as an "admin all" alias —
 * it grants every scope, every tool, every path. The new
 * `config.server.tokens` array lets the operator hand out narrower
 * credentials (read-only, path-scoped, tool-whitelisted).
 *
 * Why this lives in `mcp-server` and not `service`: it's a transport-
 * level concern (who is allowed to TALK to the vault), not a content-
 * level one (the DSGVO stack in `service/Privacy.ts` handles what
 * leaves the vault toward LLMs).
 */

export interface TokenScope {
    /** Human-readable label for logs / audit; either the operator-provided one or a short token hint. */
    label: string;
    /** May invoke read-only tools (search, read_note, list_notes, graph, …). */
    read: boolean;
    /** May invoke writing tools (write_note, update_note, delete_note, …). */
    write: boolean;
    /**
     * Allowed note-path prefixes (path-arg of a tool must start with one
     * of these). Empty = no path restriction. Match is case-sensitive.
     */
    pathPrefixes: readonly string[];
    /** Allowed tool names. Empty = no tool restriction. */
    tools: readonly string[];
}

const ADMIN_SCOPE: TokenScope = {
    label: 'admin (single-token mode)',
    read: true,
    write: true,
    pathPrefixes: [],
    tools: []
};

const tokenHint = (token: string): string => {
    if (token.length <= 8) return `…${token.slice(-2)}`;
    return `…${token.slice(-4)}`;
};

/**
 * Parse the `Bearer <token>` header. Returns the raw token or null when
 * the header is missing / malformed.
 */
export const parseBearer = (header: string | undefined): string | null => {
    if (typeof header !== 'string') return null;
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    return token.length > 0 ? token : null;
};

/**
 * Timing-safe token comparison. Buffers of unequal length always return
 * false (and don't reach `timingSafeEqual`, which throws on mismatch).
 */
const tokensMatch = (a: string, b: string): boolean => {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
};

const userRecordToScope = (user: UserRecord): TokenScope => ({
    label: user.label,
    read: user.read,
    write: user.write,
    pathPrefixes: user.pathPrefixes,
    tools: user.tools
});

/**
 * Resolve which scope applies to a request. Returns null when no token
 * configuration is present at all (the caller decides whether that's a
 * grant-all dev mode or a 401), or when the request's token didn't
 * match any configured entry.
 *
 * When `userStore` is provided (mode=server), it takes precedence over
 * `config.server.tokens` — yaml entries are ignored. Local mode passes
 * userStore=null and uses the yaml path exclusively.
 */
export const resolveTokenScope = async (
    authHeader: string | undefined,
    config: Config,
    userStore: UserStore | null = null
): Promise<TokenScope | null> => {
    const provided = parseBearer(authHeader);
    if (provided === null) return null;

    if (userStore !== null) {
        const user = await userStore.findByToken(provided);
        if (user === null) return null;
        void userStore.touchLastUsed(user.id);
        return userRecordToScope(user);
    }

    const granular = config.server.tokens;
    if (granular !== undefined) {
        for (const entry of granular) {
            if (tokensMatch(provided, entry.token)) {
                return {
                    label: entry.label ?? `token-${tokenHint(entry.token)}`,
                    read: entry.read === true,
                    write: entry.write === true,
                    pathPrefixes: entry.pathPrefixes ?? [],
                    tools: entry.tools ?? []
                };
            }
        }
    }

    const legacy = config.server.token;
    if (legacy !== undefined && legacy.length > 0 && tokensMatch(provided, legacy)) {
        return ADMIN_SCOPE;
    }

    return null;
};

/**
 * True if any auth configuration exists (legacy single-token, granular
 * tokens array with entries, OR a backing user store). Drives the
 * "missing auth" warning at startup.
 */
export const isAuthConfigured = (config: Config, userStore: UserStore | null = null): boolean => {
    if (userStore !== null) return true;
    const s = config.server;
    if (s.token !== undefined && s.token.length > 0) return true;
    if (s.tokens !== undefined && s.tokens.length > 0) return true;
    return false;
};

/**
 * Allow-all scope used when the operator hasn't configured any tokens
 * (localhost-only dev mode). The startup warning has already nagged
 * about this; the scope object exists so the rest of the pipeline can
 * treat "no auth" and "authed admin" uniformly.
 */
export const NO_AUTH_SCOPE: TokenScope = {
    label: 'unauthenticated (no token configured)',
    read: true,
    write: true,
    pathPrefixes: [],
    tools: []
};

/**
 * True if the scope is unrestricted admin: read + write, no path-prefix
 * narrowing, no tool whitelist. Both the legacy single-token ADMIN_SCOPE
 * and any user created via `npm run user create --read --write` (without
 * --prefix or --tool) pass this check. Used by privileged admin
 * endpoints (e.g. POST /admin/flush-auth-cache) where path/tool ACLs
 * don't apply but we still need to gate on "can this caller do
 * everything?".
 */
export const isAdminScope = (scope: TokenScope): boolean => {
    return scope.read
        && scope.write
        && scope.pathPrefixes.length === 0
        && scope.tools.length === 0;
};

/**
 * Decide whether a tool invocation passes the per-token ACL. Returns
 * a string error message on denial, or null on allow. The caller
 * surfaces the error to the MCP client.
 */
export const checkScope = (
    scope: TokenScope,
    tool: {name: string; mode: 'read' | 'write'},
    pathArg: string | undefined
): string | null => {
    if (tool.mode === 'write' && !scope.write) {
        return `token "${scope.label}" lacks write scope; required for tool ${tool.name}`;
    }
    if (tool.mode === 'read' && !scope.read) {
        return `token "${scope.label}" lacks read scope; required for tool ${tool.name}`;
    }
    if (scope.tools.length > 0 && !scope.tools.includes(tool.name)) {
        return `token "${scope.label}" is not allowed to call tool ${tool.name} (tool whitelist set)`;
    }
    if (pathArg !== undefined && scope.pathPrefixes.length > 0) {
        const allowed = scope.pathPrefixes.some((p) => pathArg.startsWith(p));
        if (!allowed) {
            return `token "${scope.label}" is not allowed to touch path "${pathArg}" (path-prefix scope: ${scope.pathPrefixes.join(', ')})`;
        }
    }
    return null;
};