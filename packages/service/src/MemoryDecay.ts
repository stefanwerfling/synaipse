import type {Note, NoteId} from '@synaipse/core';

export interface DecayCandidate {
    id: NoteId;
    title: string;
    mtime: number;
    ageDays: number;
}

export interface DecayOptions {
    /** Notes whose mtime is older than this are eligible. Default 90. */
    olderThanDays?: number;
    /** Restrict search to notes under this vault-relative prefix, e.g. "Crawler/". */
    pathPrefix?: string;
    /** Maximum number of candidates returned. Default unlimited. */
    limit?: number;
    /**
     * Path prefix used for the archive. Notes already under this prefix are
     * never returned as candidates (don't re-archive what's already archived).
     * Default "Archive/".
     */
    archivePrefix?: string;
}

const MS_PER_DAY = 86_400_000;

/**
 * A note is a decay candidate when it is unanchored and untouched:
 *   - no incoming wikilinks (backlinks.length === 0)
 *   - no tags (frontmatter + inline — both feed Note.tags)
 *   - not pinned (frontmatter.pinned !== true)
 *   - not a prime/index note (frontmatter.prime !== true)
 *   - not already under the archive prefix
 *   - mtime older than the threshold
 *
 * Returned sorted oldest-first (largest ageDays first).
 */
export const findDecayCandidates = (
    notes: readonly Note[],
    now: number,
    opts: DecayOptions = {}
): DecayCandidate[] => {
    const olderThanDays = opts.olderThanDays ?? 90;
    const pathPrefix = opts.pathPrefix ?? '';
    const archivePrefix = opts.archivePrefix ?? 'Archive/';
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    const thresholdMs = olderThanDays * MS_PER_DAY;

    const candidates: DecayCandidate[] = [];

    for (const note of notes) {
        if (pathPrefix.length > 0 && !note.id.startsWith(pathPrefix)) {
            continue;
        }

        if (note.id.startsWith(archivePrefix)) {
            continue;
        }

        if (note.backlinks.length > 0) {
            continue;
        }

        if (note.tags.length > 0) {
            continue;
        }

        if (note.frontmatter['pinned'] === true) {
            continue;
        }

        if (note.frontmatter['prime'] === true) {
            continue;
        }

        const ageMs = now - note.mtime;

        if (ageMs < thresholdMs) {
            continue;
        }

        candidates.push({
            id: note.id,
            title: note.title,
            mtime: note.mtime,
            ageDays: Math.floor(ageMs / MS_PER_DAY)
        });
    }

    candidates.sort((a, b) => b.ageDays - a.ageDays);

    return candidates.slice(0, limit);
};

/**
 * Map a vault note id to its archive destination. Idempotent for paths that
 * already live under the archive prefix.
 */
export const archivePathFor = (id: NoteId, archivePrefix = 'Archive/'): string => {
    return id.startsWith(archivePrefix) ? id : `${archivePrefix}${id}`;
};