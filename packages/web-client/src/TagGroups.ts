export interface TagEntry {
    tag: string;
    count: number;
}

export interface TagGroup {
    name: string;
    entries: TagEntry[];
    total: number;
}

const UNGROUPED = '';

const splitOnce = (tag: string): {head: string; tail: string} => {
    const idx = tag.indexOf('/');

    if (idx === -1) {
        return {head: UNGROUPED, tail: tag};
    }

    return {head: tag.slice(0, idx), tail: tag.slice(idx + 1)};
};

export const groupTags = (entries: readonly TagEntry[]): TagGroup[] => {
    const buckets = new Map<string, TagEntry[]>();

    for (const entry of entries) {
        const {head} = splitOnce(entry.tag);
        const bucket = buckets.get(head);

        if (bucket) {
            bucket.push(entry);
        } else {
            buckets.set(head, [entry]);
        }
    }

    const groups: TagGroup[] = [];

    for (const [name, list] of buckets) {
        const sorted = [...list].sort(
            (a, b) => b.count - a.count || a.tag.localeCompare(b.tag)
        );
        const total = sorted.reduce((sum, e) => sum + e.count, 0);
        groups.push({name, entries: sorted, total});
    }

    return groups.sort((a, b) => {
        if (a.name === UNGROUPED) return 1;
        if (b.name === UNGROUPED) return -1;
        return b.total - a.total || a.name.localeCompare(b.name);
    });
};

const matches = (haystack: string, needle: string): boolean => {
    if (needle.length === 0) {
        return true;
    }

    return haystack.toLowerCase().includes(needle.toLowerCase());
};

export const filterEntries = (entries: readonly TagEntry[], query: string): TagEntry[] => {
    const q = query.trim();

    if (q.length === 0) {
        return [...entries];
    }

    return entries.filter((e) => matches(e.tag, q));
};

export const groupLabel = (name: string): string => {
    return name === UNGROUPED ? 'other' : name;
};

export const isUngrouped = (name: string): boolean => name === UNGROUPED;