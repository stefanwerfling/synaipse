import type {ToolHandler} from './Shared.js';

/**
 * ACL classification for every tool, applied as a post-pass to
 * `buildTools()`. Kept as a table here (rather than inline per tool
 * definition) so the 24-tool list stays scannable and adding/removing
 * write tools is one line, not a hunt-for-the-right-position edit.
 */
const ACL_TABLE: Record<string, {mode: 'read' | 'write'; pathArg?: string; unscopedOnly?: boolean}> = {
    synaipse_write_note:   {mode: 'write', pathArg: 'path'},
    synaipse_update_note:  {mode: 'write', pathArg: 'id'},
    synaipse_edit_note:    {mode: 'write', pathArg: 'id'},
    synaipse_delete_note:  {mode: 'write', pathArg: 'id'},
    synaipse_write_asset:  {mode: 'write', pathArg: 'noteId'},
    synaipse_link_note:    {mode: 'write', pathArg: 'fromId'},
    synaipse_log_session:  {mode: 'write'},
    synaipse_remember:     {mode: 'write'},
    // Roadmap tools scope on ctx.project (no pathArg — the note path is derived
    // from the project, never taken from the caller), like remember/log_session.
    synaipse_roadmap_plan:        {mode: 'write'},
    synaipse_roadmap_update_step: {mode: 'write'},
    synaipse_roadmap_move:        {mode: 'write'},
    synaipse_roadmap_set_active:  {mode: 'write'},
    synaipse_roadmap_link_note:   {mode: 'write'},
    synaipse_roadmap_rollback:    {mode: 'write'},
    synaipse_roadmap_get:         {mode: 'read'},
    synaipse_roadmap_history:     {mode: 'read'},
    // Benchmark tools scope on ctx.project too, same reasoning as roadmap.
    synaipse_benchmark_add:       {mode: 'write'},
    synaipse_benchmark_update:    {mode: 'write'},
    synaipse_benchmark_list:      {mode: 'read'},
    synaipse_read_note:    {mode: 'read',  pathArg: 'id'},
    synaipse_backlinks:    {mode: 'read',  pathArg: 'id'},
    synaipse_outgoing_links: {mode: 'read', pathArg: 'id'},
    synaipse_related:      {mode: 'read',  pathArg: 'id'},
    synaipse_verify_history: {mode: 'read', unscopedOnly: true},
    synaipse_snapshot_list:   {mode: 'read', unscopedOnly: true}
};

const applyAcl = (tools: readonly ToolHandler[]): ToolHandler[] => tools.map((t) => {
    const entry = ACL_TABLE[t.definition.name];
    return {
        ...t,
        mode: entry?.mode ?? 'read',
        ...(entry?.pathArg !== undefined ? {pathArg: entry.pathArg} : {}),
        ...(entry?.unscopedOnly === true ? {unscopedOnly: true} : {})
    };
});

export {ACL_TABLE, applyAcl};
