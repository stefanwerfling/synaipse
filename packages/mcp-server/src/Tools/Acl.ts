import {LIMIT_MAX, type ToolHandler} from './Shared.js';

interface AclEntry {
    mode: 'read' | 'write';
    pathArg?: string;
    unscopedOnly?: boolean;
    /** Write may overwrite or remove existing content (MCP `destructiveHint`). */
    destructive?: boolean;
    /** Repeating the call with the same args has no further effect (MCP `idempotentHint`). */
    idempotent?: boolean;
}

/**
 * ACL classification for every tool, applied as a post-pass to
 * `buildTools()`. Single source for the scope check (read/write, path
 * argument) AND the MCP tool annotations the client shows the user
 * (readOnly/destructive/idempotent) — so the two can never disagree.
 * Tools not listed are read-only.
 */
const ACL_TABLE: Record<string, AclEntry> = {
    synaipse_write_note:   {mode: 'write', pathArg: 'path', destructive: true, idempotent: true},
    synaipse_update_note:  {mode: 'write', pathArg: 'id', destructive: true, idempotent: true},
    synaipse_edit_note:    {mode: 'write', pathArg: 'id', destructive: true},
    synaipse_delete_note:  {mode: 'write', pathArg: 'id', destructive: true, idempotent: true},
    synaipse_write_asset:  {mode: 'write', pathArg: 'noteId', idempotent: true},
    synaipse_link_note:    {mode: 'write', pathArg: 'fromId', idempotent: true},
    synaipse_log_session:  {mode: 'write'},
    synaipse_remember:     {mode: 'write'},
    // Roadmap tools scope on ctx.project (no pathArg — the note path is derived
    // from the project, never taken from the caller), like remember/log_session.
    // Roadmap writes are non-destructive by construction (soft-delete, merge,
    // every write versioned), hence no destructive flag.
    synaipse_roadmap_plan:        {mode: 'write'},
    synaipse_roadmap_update_step: {mode: 'write'},
    synaipse_roadmap_move:        {mode: 'write', idempotent: true},
    synaipse_roadmap_set_active:  {mode: 'write', idempotent: true},
    synaipse_roadmap_link_note:   {mode: 'write', idempotent: true},
    synaipse_roadmap_rollback:    {mode: 'write'},
    synaipse_roadmap_get:         {mode: 'read'},
    synaipse_roadmap_history:     {mode: 'read'},
    // Benchmark tools scope on ctx.project too, same reasoning as roadmap.
    synaipse_benchmark_add:       {mode: 'write'},
    synaipse_benchmark_update:    {mode: 'write', idempotent: true},
    synaipse_benchmark_list:      {mode: 'read'},
    synaipse_read_note:    {mode: 'read',  pathArg: 'id'},
    synaipse_links:        {mode: 'read',  pathArg: 'id'},
    synaipse_backlinks:    {mode: 'read',  pathArg: 'id'},
    synaipse_outgoing_links: {mode: 'read', pathArg: 'id'},
    synaipse_related:      {mode: 'read',  pathArg: 'id'},
    synaipse_verify_history: {mode: 'read', unscopedOnly: true},
    synaipse_snapshot_list:   {mode: 'read', unscopedOnly: true}
};

/**
 * Deprecated tool → replacement. The old name stays callable (hidden from
 * tools/list) for one version so existing prompts and hooks keep working.
 */
export const DEPRECATED_TOOLS: Readonly<Record<string, string>> = {
    synaipse_list_notes: 'synaipse_list',
    synaipse_recent: 'synaipse_list',
    synaipse_notes_by_tag: 'synaipse_list',
    synaipse_backlinks: 'synaipse_links',
    synaipse_outgoing_links: 'synaipse_links'
};

/** "synaipse_roadmap_update_step" → "Roadmap update step" */
const titleFromName = (name: string): string => {
    const words = name.replace(/^synaipse_/, '').split('_');
    const text = words.join(' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * Tighten loose `limit: {type: 'number'}` schemas into bounded integers so
 * the model sees the valid range up front (handlers clamp as well).
 */
const boundLimits = (schema: ToolHandler['definition']['inputSchema']): ToolHandler['definition']['inputSchema'] => {
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const limit = props?.limit;
    if (props === undefined || limit === undefined) return schema;
    return {
        ...schema,
        properties: {...props, limit: {...limit, type: 'integer', minimum: 1, maximum: LIMIT_MAX}}
    };
};

const applyAcl = (tools: readonly ToolHandler[]): ToolHandler[] => tools.map((t) => {
    const entry: AclEntry = ACL_TABLE[t.definition.name] ?? {mode: 'read'};
    const readOnly = entry.mode === 'read';
    return {
        ...t,
        definition: {
            ...t.definition,
            title: t.definition.title ?? titleFromName(t.definition.name),
            inputSchema: boundLimits(t.definition.inputSchema),
            annotations: {
                readOnlyHint: readOnly,
                ...(readOnly ? {} : {destructiveHint: entry.destructive === true, idempotentHint: entry.idempotent === true}),
                // Synaipse only touches its own vault — never the open web.
                openWorldHint: false,
                ...t.definition.annotations
            }
        },
        mode: entry.mode,
        ...(DEPRECATED_TOOLS[t.definition.name] !== undefined ? {hidden: true} : {}),
        ...(entry.pathArg !== undefined ? {pathArg: entry.pathArg} : {}),
        ...(entry.unscopedOnly === true ? {unscopedOnly: true} : {})
    };
});

export {ACL_TABLE, applyAcl};
