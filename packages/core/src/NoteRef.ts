/**
 * Resolve a free-form note reference — as stored on roadmap steps / benchmark
 * entries or typed by a user — to a concrete note. A reference may be a full
 * note id (`Memory/x/y.md`), a vault path missing its `.md`, a note title, an
 * alias, or a bare filename slug. Resolution is deterministic and shared by the
 * MCP write path, the web UI and the data migration so every surface agrees on
 * what a link points at (and, crucially, on what does NOT resolve — those are
 * rejected at write time instead of silently becoming dead links).
 *
 * Pure (no I/O), so it lives in core and is safe in the browser bundle.
 */

/** Minimal note shape the resolver needs. Aliases default to none. */
export interface NoteRefTarget {
    id: string;
    title: string;
    aliases?: readonly string[];
}

/** Filename of a note id without its directory or `.md` suffix. */
const baseName = (id: string): string => {
    const last = id.slice(id.lastIndexOf('/') + 1);
    return last.endsWith('.md') ? last.slice(0, -3) : last;
};

/**
 * Resolve a reference to the target note, or null when nothing matches (or the
 * only case-insensitive match is ambiguous). Match order, first hit wins:
 *   1. exact note id
 *   2. vault path (with `.md` appended if missing), exact or as a path suffix
 *   3. exact title
 *   4. exact alias
 *   5. exact filename base (`invoice-split` → `.../invoice-split.md`)
 *   6. case-insensitive match on any of the above — only if it is unambiguous.
 */
export const resolveNoteRefTarget = (
    ref: string,
    notes: readonly NoteRefTarget[]
): NoteRefTarget | null => {
    const trimmed = ref.trim();
    if (trimmed.length === 0) {
        return null;
    }

    const byId = notes.find((n) => n.id === trimmed);
    if (byId !== undefined) {
        return byId;
    }

    const withMd = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
    const byPath = notes.find((n) => n.id === withMd || n.id.endsWith(`/${withMd}`));
    if (byPath !== undefined) {
        return byPath;
    }

    const byTitle = notes.find((n) => n.title === trimmed);
    if (byTitle !== undefined) {
        return byTitle;
    }

    const byAlias = notes.find((n) => (n.aliases ?? []).includes(trimmed));
    if (byAlias !== undefined) {
        return byAlias;
    }

    const byBase = notes.find((n) => baseName(n.id) === trimmed);
    if (byBase !== undefined) {
        return byBase;
    }

    const lower = trimmed.toLowerCase();
    const lowerMd = withMd.toLowerCase();
    const ci = notes.filter(
        (n) =>
            n.id.toLowerCase() === lower ||
            n.id.toLowerCase() === lowerMd ||
            n.id.toLowerCase().endsWith(`/${lowerMd}`) ||
            n.title.toLowerCase() === lower ||
            (n.aliases ?? []).some((a) => a.toLowerCase() === lower) ||
            baseName(n.id).toLowerCase() === lower
    );
    if (ci.length === 1) {
        return ci[0] ?? null;
    }

    return null;
};

/** {@link resolveNoteRefTarget} returning just the note id, or null. */
export const resolveNoteRef = (
    ref: string,
    notes: readonly NoteRefTarget[]
): string | null => resolveNoteRefTarget(ref, notes)?.id ?? null;

/**
 * Canonical string to STORE for a resolved reference: the target's title (the
 * vault-native wikilink target, so the roadmap body's `[[title]]` feeds
 * backlinks/graph), falling back to the id when a note has no title.
 */
export const canonicalNoteLink = (target: NoteRefTarget): string =>
    target.title.trim().length > 0 ? target.title.trim() : target.id;
