import type {Note} from '@synaipse/core';
import {resolveNoteRefTarget} from '@synaipse/core';
import {isPathInScope, type SynaipseService} from '@synaipse/service';

/**
 * Token-economy helpers (plan P2 / B3): what a tool result carries is
 * paid for in every turn, so results say what the model needs to act —
 * not everything the service happens to return.
 */

const DAY_MS = 86_400_000;

/** Coarse relative age: "now", "5m", "3h", "12d", "8mo", "2y". */
export const ageOf = (ms: number, now: number = Date.now()): string => {
    const diff = Math.max(0, now - ms);
    if (diff < 60_000) return 'now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
    if (diff < DAY_MS) return `${Math.floor(diff / 3_600_000)}h`;
    if (diff < 60 * DAY_MS) return `${Math.floor(diff / DAY_MS)}d`;
    if (diff < 730 * DAY_MS) return `${Math.floor(diff / (30 * DAY_MS))}mo`;
    return `${Math.floor(diff / (365 * DAY_MS))}y`;
};

/** Epoch ms → `{modified: ISO, age}` — readable for a model, unlike raw epoch. */
export const modifiedOf = (mtime: number): {modified: string; age: string} => ({
    modified: new Date(mtime).toISOString(),
    age: ageOf(mtime)
});

/**
 * Write-tool result: enough to cite and re-address the note, plus
 * warnings the model can act on (dead wikilinks). Never the full body —
 * the caller just sent it.
 */
export const writeResult = (
    service: SynaipseService,
    note: Note,
    previousHash?: string
): Record<string, unknown> => {
    const dead = service.unresolvedWikilinks(note);
    return {
        id: note.id,
        title: note.title,
        hash: note.hash,
        ...modifiedOf(note.mtime),
        ...(previousHash !== undefined ? {changed: previousHash !== note.hash} : {}),
        ...(dead.length > 0 ? {warnings: [`unresolved wikilinks (no note with that title/alias): ${dead.map((d) => `[[${d}]]`).join(', ')}`]} : {})
    };
};

/**
 * Resolve what the model passed as a note reference — vault path, path
 * without `.md`, title, alias or file basename (see NoteRef) — to a note
 * id. Notes outside the caller's path scope are invisible here. Throws a
 * "not found" error that names close candidates, so the model can retry
 * with the right id instead of guessing.
 */
export const resolveNoteId = (service: SynaipseService, ref: string): string => {
    if (service.tryReadNote(ref) !== undefined && isPathInScope(ref)) {
        return ref;
    }

    const targets = service.listNotes()
        .filter((n) => isPathInScope(n.id))
        .map((n) => ({
            id: n.id,
            title: n.title,
            aliases: Array.isArray(n.frontmatter.aliases) ? n.frontmatter.aliases.filter((a): a is string => typeof a === 'string') : []
        }));
    const hit = resolveNoteRefTarget(ref, targets);
    if (hit !== null) {
        return hit.id;
    }

    const needle = ref.toLowerCase().replace(/\.md$/, '');
    const candidates = targets
        .filter((t) => t.title.toLowerCase().includes(needle) || t.id.toLowerCase().includes(needle))
        .slice(0, 3)
        .map((t) => `"${t.id}" (${t.title})`);
    const hint = candidates.length > 0
        ? ` Did you mean ${candidates.join(' or ')}?`
        : ' Use synaipse_search to find it.';
    throw new Error(`Note "${ref}" not found.${hint}`);
};

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * Body of the section under the first heading whose text equals
 * `heading` (case-insensitive, leading #'s optional), up to the next
 * heading of the same or a higher level. Fenced code is skipped when
 * looking for headings. Returns null when no such heading exists.
 */
export const extractSection = (content: string, heading: string): string | null => {
    const wanted = heading.replace(/^#+\s*/, '').trim().toLowerCase();
    const lines = content.split('\n');
    let inFence = false;
    let start = -1;
    let level = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        const match = HEADING_RE.exec(line);
        if (match === null) continue;
        const depth = match[1]!.length;
        if (start === -1) {
            if (match[2]!.trim().toLowerCase() === wanted) {
                start = i;
                level = depth;
            }
        } else if (depth <= level) {
            return lines.slice(start, i).join('\n').trimEnd();
        }
    }

    return start === -1 ? null : lines.slice(start).join('\n').trimEnd();
};

/** Headings of a note body (outside code fences), for "section not found" hints. */
export const headingsOf = (content: string): string[] => {
    const out: string[] = [];
    let inFence = false;
    for (const line of content.split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        const match = HEADING_RE.exec(line);
        if (match !== null) out.push(match[2]!.trim());
    }
    return out;
};
