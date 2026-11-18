import type {Note} from '@synaipse/core';
import type {SynaipseService} from '@synaipse/service';

/** One row of `/api/notes`: what the note tree and the palette need. */
export interface NoteSummary {
    id: string;
    title: string;
    tags: string[];
    mtime: number;
    aliases: string[];
    isPrivate?: true;
}

/** Changes whenever anything a summary shows can change (content incl. frontmatter, or the file). */
export const noteStamp = (note: Note): string => `${note.hash}:${note.mtime}`;

/**
 * Summaries per service and note id, reused while the note's stamp is
 * unchanged. `Vault.list()` hands out fresh copies on every call, so the
 * stamp (not object identity) decides; deleted ids are pruned lazily by
 * {@link pruneSummaries}.
 */
const caches = new WeakMap<SynaipseService, Map<string, {stamp: string; summary: NoteSummary}>>();

const cacheOf = (service: SynaipseService): Map<string, {stamp: string; summary: NoteSummary}> => {
    let cache = caches.get(service);
    if (cache === undefined) {
        cache = new Map();
        caches.set(service, cache);
    }
    return cache;
};

export const noteSummary = (service: SynaipseService, note: Note): NoteSummary => {
    const cache = cacheOf(service);
    const stamp = noteStamp(note);
    const cached = cache.get(note.id);
    if (cached !== undefined && cached.stamp === stamp) return cached.summary;

    const flags = service.noteFlags(note);
    const summary: NoteSummary = {
        id: note.id,
        title: note.title,
        tags: note.tags,
        mtime: note.mtime,
        aliases: Array.isArray(note.frontmatter.aliases)
            ? note.frontmatter.aliases.filter((a): a is string => typeof a === 'string')
            : [],
        ...(flags.private ? {isPrivate: true as const} : {})
    };

    cache.set(note.id, {stamp, summary});
    return summary;
};

/** Drop cached summaries of notes that no longer exist. */
export const pruneSummaries = (service: SynaipseService, removed: Iterable<string>): void => {
    const cache = caches.get(service);
    if (cache === undefined) return;
    for (const id of removed) cache.delete(id);
};
