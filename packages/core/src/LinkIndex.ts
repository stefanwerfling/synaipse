import type {Frontmatter, NoteId} from './Types.js';

/** Minimal note shape the index needs — any Note satisfies it. */
export interface LinkIndexNote {
    id: NoteId;
    title: string;
    wikilinks: readonly string[];
    frontmatter: Pick<Frontmatter, 'aliases'>;
}

const aliasesOf = (note: LinkIndexNote): string[] => {
    const raw = note.frontmatter.aliases;
    if (!Array.isArray(raw)) return [];
    return raw.filter((a): a is string => typeof a === 'string' && a.length > 0);
};

/**
 * One-shot `link text → note id` map with the canonical precedence:
 * titles before aliases, first note wins among duplicates. Use this (or
 * {@link LinkIndex.resolve}) everywhere a wikilink target is resolved so
 * graph edges, backlinks, related() and the search graph signal agree.
 */
export const buildLinkKeyMap = (notes: Iterable<LinkIndexNote>): Map<string, NoteId> => {
    const list = [...notes];
    const map = new Map<string, NoteId>();
    for (const note of list) {
        if (note.title.length > 0 && !map.has(note.title)) map.set(note.title, note.id);
    }
    for (const note of list) {
        for (const alias of aliasesOf(note)) {
            if (!map.has(alias)) map.set(alias, note.id);
        }
    }
    return map;
};

/**
 * Incremental wikilink → backlink index.
 *
 * Wikilinks are stored by their raw target text (`[[Some Title]]` →
 * "Some Title"); resolution to a note id happens at query time:
 *
 *   - a title match wins over an alias match,
 *   - among several notes with the same title (or alias) the one that was
 *     indexed first wins.
 *
 * That mirrors `Vault.rebuildBacklinks` and `packages/web-client/src/Wikilinks.ts`
 * so every storage mode and the UI agree on what `[[X]]` points at — but
 * without a full-vault rebuild per write: upsert/remove are O(links of the
 * note), backlinksOf is O(keys of the note + its backlinks).
 */
export class LinkIndex {
    /** raw link text → ids of notes containing `[[text]]` */
    private readonly sources = new Map<string, Set<NoteId>>();
    /** title → ids with that title (insertion order = precedence) */
    private readonly byTitle = new Map<string, Set<NoteId>>();
    /** alias → ids carrying that alias (insertion order = precedence) */
    private readonly byAlias = new Map<string, Set<NoteId>>();
    private readonly notes = new Map<NoteId, {title: string; aliases: string[]; wikilinks: string[]}>();
    /**
     * backlinksOf() results, dropped wholesale on every mutation. Adapters
     * attach backlinks to every note in list(); between writes that is
     * now a map lookup instead of a recomputation per note.
     */
    private readonly memo = new Map<NoteId, readonly NoteId[]>();

    public clear(): void {
        this.memo.clear();
        this.sources.clear();
        this.byTitle.clear();
        this.byAlias.clear();
        this.notes.clear();
    }

    public upsert(note: LinkIndexNote): void {
        this.memo.clear();
        const prev = this.notes.get(note.id);
        const next = {title: note.title, aliases: aliasesOf(note), wikilinks: [...new Set(note.wikilinks)]};

        if (prev !== undefined) {
            // Keep the note's precedence slot when its title/aliases are
            // unchanged — re-inserting would demote it behind later notes.
            if (prev.title !== next.title) {
                removeFrom(this.byTitle, prev.title, note.id);
                addTo(this.byTitle, next.title, note.id);
            }
            for (const a of prev.aliases) if (!next.aliases.includes(a)) removeFrom(this.byAlias, a, note.id);
            for (const a of next.aliases) if (!prev.aliases.includes(a)) addTo(this.byAlias, a, note.id);
            for (const l of prev.wikilinks) if (!next.wikilinks.includes(l)) removeFrom(this.sources, l, note.id);
            for (const l of next.wikilinks) if (!prev.wikilinks.includes(l)) addTo(this.sources, l, note.id);
        } else {
            if (next.title.length > 0) addTo(this.byTitle, next.title, note.id);
            for (const a of next.aliases) addTo(this.byAlias, a, note.id);
            for (const l of next.wikilinks) addTo(this.sources, l, note.id);
        }

        this.notes.set(note.id, next);
    }

    public remove(id: NoteId): void {
        const prev = this.notes.get(id);
        if (prev === undefined) return;
        this.memo.clear();
        removeFrom(this.byTitle, prev.title, id);
        for (const a of prev.aliases) removeFrom(this.byAlias, a, id);
        for (const l of prev.wikilinks) removeFrom(this.sources, l, id);
        this.notes.delete(id);
    }

    /** Resolve a wikilink target text to a note id (title first, then alias). */
    public resolve(key: string): NoteId | undefined {
        const byTitle = first(this.byTitle.get(key));
        if (byTitle !== undefined) return byTitle;
        return first(this.byAlias.get(key));
    }

    /** Ids of notes whose wikilinks resolve to `id`. */
    public backlinksOf(id: NoteId): NoteId[] {
        const cached = this.memo.get(id);
        if (cached !== undefined) return [...cached];

        const note = this.notes.get(id);
        if (note === undefined) return [];

        const out = new Set<NoteId>();
        for (const key of [note.title, ...note.aliases]) {
            if (key.length === 0 || this.resolve(key) !== id) continue;
            const sources = this.sources.get(key);
            if (sources === undefined) continue;
            for (const s of sources) {
                if (s !== id) out.add(s);
            }
        }
        const result = [...out];
        this.memo.set(id, result);
        return [...result];
    }
}

const addTo = (map: Map<string, Set<NoteId>>, key: string, id: NoteId): void => {
    let bucket = map.get(key);
    if (bucket === undefined) {
        bucket = new Set();
        map.set(key, bucket);
    }
    bucket.add(id);
};

const removeFrom = (map: Map<string, Set<NoteId>>, key: string, id: NoteId): void => {
    const bucket = map.get(key);
    if (bucket === undefined) return;
    bucket.delete(id);
    if (bucket.size === 0) map.delete(key);
};

const first = (set: Set<NoteId> | undefined): NoteId | undefined => {
    if (set === undefined) return undefined;
    for (const v of set) return v;
    return undefined;
};
