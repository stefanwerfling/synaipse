import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import type {Note, SearchMode} from '@synaipse/core';
import {SynaipseService, getAuditTokenLabel, isPathInScope} from '@synaipse/service';
import type {EventKind} from '../EventPublisher.js';

const CONSENT_TIMEOUT_MS = 60_000;

/**
 * Enforce just-in-time consent for note reads triggered by MCP. When
 * the note's `frontmatter.mcp_consent === "pending"`, the tool handler
 * blocks up to CONSENT_TIMEOUT_MS on a UI-side approve/deny before
 * returning the note or throwing.
 *
 * Callers that don't require the whole note (list/aggregate tools)
 * MUST NOT go through this path; they use {@link filterByConsent}
 * instead, which silently drops pending/denied entries.
 */
const enforceReadConsent = async (service: SynaipseService, id: string): Promise<Note> => {
    const initial = service.readNote(id);
    const status = initial.frontmatter.mcp_consent;

    if (status === undefined || status === 'granted') {
        return initial;
    }

    if (status === 'denied') {
        throw new Error(`Note "${id}" is denied for MCP access by user consent.`);
    }

    // status === 'pending' → long-poll the UI
    const requester = getAuditTokenLabel() ?? 'unknown';
    const result = await service.getConsentStore().request(id, requester, CONSENT_TIMEOUT_MS);

    if (result === 'timeout') {
        throw new Error(`Note "${id}" needs user consent before MCP can read it. Prompt is pending in the UI; retry the tool call in a moment.`);
    }

    if (result === 'denied') {
        throw new Error(`Note "${id}" was denied by user consent.`);
    }

    // Approved. service.resolveConsent already wrote the decision to
    // frontmatter; re-read so the returned note reflects the new state.
    return service.readNote(id);
};

/**
 * Silently drop notes that are consent-blocked (pending or denied)
 * from aggregate result lists. Notes without an `mcp_consent` field
 * pass through unchanged — the consent layer is opt-in per note.
 * Returns the filtered list plus the number that were removed so
 * callers can surface a `skippedByConsent` count.
 */
const filterByConsent = <T>(
    service: SynaipseService,
    items: readonly T[],
    getId: (item: T) => string
): {items: T[]; skipped: number} => {
    const kept: T[] = [];
    let skipped = 0;

    for (const item of items) {
        const id = getId(item);
        // Out-of-scope items are dropped silently (not counted) so a
        // path-scoped token can't even learn how many hidden notes matched.
        if (!isPathInScope(id)) continue;
        const note = service.tryReadNote(id);
        const status = note?.frontmatter.mcp_consent;
        if (status === 'pending' || status === 'denied') {
            skipped++;
            continue;
        }
        kept.push(item);
    }

    return {items: kept, skipped};
};

/**
 * Same as {@link filterByConsent} for lists of Note objects.
 */
const filterNotesByConsent = (
    notes: readonly Note[]
): {items: Note[]; skipped: number} => {
    const kept: Note[] = [];
    let skipped = 0;
    for (const note of notes) {
        if (!isPathInScope(note.id)) continue;
        const status = note.frontmatter.mcp_consent;
        if (status === 'pending' || status === 'denied') {
            skipped++;
            continue;
        }
        kept.push(note);
    }
    return {items: kept, skipped};
};

export interface ToolResponse {
    content: Array<{type: 'text'; text: string}>;
    isError?: boolean;
}

export interface ToolEventInfo {
    kind: EventKind;
    touched: string[];
    query?: string;
}

export interface ToolOutcome {
    response: ToolResponse;
    event?: ToolEventInfo;
}

export interface ToolContext {
    project?: string | null;
    gitAuthor?: {name: string; email: string};
    extraTags?: readonly string[];
}

const EMPTY_CTX: ToolContext = {};

const ok = (data: unknown): ToolResponse => ({
    content: [{type: 'text', text: JSON.stringify(data, null, 2)}]
});

const asString = (value: unknown, field: string): string => {
    if (typeof value !== 'string') {
        throw new Error(`Missing string argument: ${field}`);
    }

    return value;
};

const asNumber = (value: unknown, fallback: number): number => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    return fallback;
};

const asSearchMode = (value: unknown): SearchMode => {
    if (value === 'fulltext' || value === 'semantic' || value === 'hybrid') {
        return value;
    }

    return 'hybrid';
};

export interface ToolHandler {
    definition: Tool;
    /**
     * ACL category. Read-only tools (search, read, list, graph, …) are
     * gated on the token's read scope; mutating tools (write/update/
     * delete/link/log/remember) on the write scope. Default 'read' so
     * the long list of read-only tool definitions stays uncluttered.
     */
    mode?: 'read' | 'write';
    /**
     * Name of the input field carrying the note path, if any. The
     * scope check uses it to compare against `pathPrefixes`. Tools
     * without a path argument (search, list_tags, recent, …) leave
     * this undefined and skip the path-prefix check.
     */
    pathArg?: string;
    /**
     * Tool output can't be filtered per path (history forensics over the
     * whole vault). Denied for tokens with a path-prefix scope.
     */
    unscopedOnly?: boolean;
    handle: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolOutcome>;
}

export {enforceReadConsent, filterByConsent, filterNotesByConsent, ok, asString, asNumber, asSearchMode, EMPTY_CTX};
