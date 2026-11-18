/**
 * Server `instructions` sent in the MCP initialize result. Clients that
 * support it (Claude Code among them) put this into the model's context,
 * so the working protocol no longer has to live in every CLAUDE.md.
 *
 * Keep it short — it costs tokens in every session. Tool-specific detail
 * belongs in the tool descriptions, not here.
 */
export const buildInstructions = (project: string | null): string => {
    const scope = project === null
        ? 'No project is set: reads are vault-wide; project-scoped writes (remember, log_session, roadmap_*) need a project via the /mcp/<project> URL segment or the x-synaipse-project header.'
        : `Active project: "${project}". Your notes live under Memory/${project}/ (write_note prefixes relative paths automatically and tags them project/${project}).`;

    return [
        'Synaipse is the user\'s long-term memory: a markdown vault with wikilinks, tags, semantic search and version history.',
        scope,
        '',
        'Working protocol:',
        '1. At session start (or when switching topic) call synaipse_prime once, with `topic` if you know it.',
        '2. Before writing, search (synaipse_search) so you update an existing note instead of creating a duplicate.',
        '3. Pick the lightest write: synaipse_remember for a one-line insight, synaipse_log_session for what you did and which notes you used, synaipse_write_note only for a curated note worth finding again (decision, how-to, architecture).',
        '4. Change existing notes with synaipse_edit_note (find/replace) or synaipse_update_note — never resend an unchanged note.',
        '5. Link instead of copying: [[Note Title]] wikilinks in the body; synaipse_link_note adds references to an existing note.',
        '',
        'Note ids are vault-relative paths like "Memory/<project>/topic.md". Results are compact JSON.'
    ].join('\n');
};
