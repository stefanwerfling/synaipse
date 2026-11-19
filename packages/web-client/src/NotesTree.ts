import type {NoteSummary} from './Api.js';

/**
 * Pure part of the notes sidebar (plan P7 / D2): grouping notes by
 * folder, primary tag or recency, and flattening the groups into the
 * fixed-height rows of the virtualised list.
 */

export type GroupMode = 'folder' | 'tag' | 'recent';

export const RECENT_BUCKETS = ['Today', 'Yesterday', 'This week', 'This month', 'Earlier'] as const;
const UNTAGGED_LABEL = 'untagged';

export interface NoteGroup {
    key: string;
    label: string;
    notes: NoteSummary[];
}

export const GROUP_ROW_H = 32;
// Two heights so the row box is large enough for whatever it actually paints.
// With tags, the meta column adds gap + a ~17px chip row that previously
// overflowed a hard-coded 56px box and overlapped the next item by ~16px.
const NOTE_ROW_H_PLAIN = 56;
const NOTE_ROW_H_TAGGED = 76;
export const noteRowHeight = (note: NoteSummary): number =>
    note.tags.length > 0 ? NOTE_ROW_H_TAGGED : NOTE_ROW_H_PLAIN;

export type VirtualRow =
    | {kind: 'group'; group: NoteGroup; key: string; isCollapsed: boolean; depth: number; totalCount: number}
    | {kind: 'note'; note: NoteSummary; depth: number};

export interface RowLayout {
    rows: VirtualRow[];
    /** Top of each row in px, same order as `rows`. */
    offsets: number[];
    height: number;
}

const startOfDay = (ts: number): number => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
};

export const recencyBucket = (mtime: number, now: number): typeof RECENT_BUCKETS[number] => {
    const today = startOfDay(now);
    const day = 86_400_000;

    if (mtime >= today) return 'Today';
    if (mtime >= today - day) return 'Yesterday';
    if (mtime >= today - day * 7) return 'This week';
    if (mtime >= today - day * 30) return 'This month';
    return 'Earlier';
};

// Top-level folders whose immediate subdirs are usually opaque IDs (UUIDs,
// hashes, dates) that would explode the tree with noise. We collapse the
// entire subtree of such folders into a single flat bucket at the top
// folder's node.
const FLAT_TOP_LEVEL_FOLDERS = new Set(['chatgpt-import', 'Clipped']);

export interface FolderNode {
    path: string;    // full vault-relative path, e.g. "Memory/decisions"
    label: string;   // leaf segment, e.g. "decisions"
    notes: NoteSummary[];
    children: FolderNode[];
}

/**
 * Build a nested folder tree from note IDs. Each `/`-separated segment
 * becomes a node; notes attach to their exact leaf folder. Notes in the
 * vault root land on the returned root node's `notes` array (its `path`
 * and `label` are empty).
 *
 * `FLAT_TOP_LEVEL_FOLDERS` are collapsed: everything under `chatgpt-import/`
 * lands directly on that top-level node's `notes`, with no descendants.
 * This keeps the tree navigable when a folder holds hundreds of opaque
 * UUID subdirectories.
 */
export const buildFolderTree = (notes: NoteSummary[]): FolderNode => {
    const root: FolderNode = {path: '', label: '', notes: [], children: []};
    const byPath = new Map<string, FolderNode>([['', root]]);

    for (const note of notes) {
        const slash = note.id.lastIndexOf('/');
        if (slash === -1) {
            root.notes.push(note);
            continue;
        }

        const folder = note.id.slice(0, slash);
        const parts = folder.split('/');
        const top = parts[0] ?? '';

        if (FLAT_TOP_LEVEL_FOLDERS.has(top)) {
            let node = byPath.get(top);
            if (node === undefined) {
                node = {path: top, label: top, notes: [], children: []};
                byPath.set(top, node);
                root.children.push(node);
            }
            node.notes.push(note);
            continue;
        }

        let acc = '';
        let parent = root;
        for (const part of parts) {
            acc = acc.length > 0 ? `${acc}/${part}` : part;
            let node = byPath.get(acc);
            if (node === undefined) {
                node = {path: acc, label: part, notes: [], children: []};
                byPath.set(acc, node);
                parent.children.push(node);
            }
            parent = node;
        }
        parent.notes.push(note);
    }

    const sortRec = (node: FolderNode): void => {
        node.children.sort((a, b) => a.label.localeCompare(b.label));
        node.notes.sort((a, b) => a.title.localeCompare(b.title));
        for (const c of node.children) sortRec(c);
    };
    sortRec(root);

    return root;
};

const countRec = (node: FolderNode): number => {
    let total = node.notes.length;
    for (const c of node.children) total += countRec(c);
    return total;
};

export const buildGroups = (notes: NoteSummary[], mode: Exclude<GroupMode, 'folder'>, now: number): NoteGroup[] => {
    const map = new Map<string, NoteGroup>();

    const ensure = (key: string, label: string): NoteGroup => {
        let group = map.get(key);

        if (group === undefined) {
            group = {key, label, notes: []};
            map.set(key, group);
        }

        return group;
    };

    if (mode === 'tag') {
        for (const note of notes) {
            const primary = note.tags[0] ?? UNTAGGED_LABEL;
            ensure(primary, primary).notes.push(note);
        }

        return [...map.values()].sort((a, b) => {
            if (a.label === UNTAGGED_LABEL) return 1;
            if (b.label === UNTAGGED_LABEL) return -1;
            return b.notes.length - a.notes.length || a.label.localeCompare(b.label);
        });
    }

    for (const bucket of RECENT_BUCKETS) {
        ensure(bucket, bucket);
    }

    for (const note of notes) {
        const bucket = recencyBucket(note.mtime, now);
        ensure(bucket, bucket).notes.push(note);
    }

    const order = new Map(RECENT_BUCKETS.map((b, i) => [b, i]));

    return [...map.values()]
        .filter((g) => g.notes.length > 0)
        .sort((a, b) => (order.get(a.label as typeof RECENT_BUCKETS[number]) ?? 0) - (order.get(b.label as typeof RECENT_BUCKETS[number]) ?? 0));
};

/**
 * Rows of the virtualised list for `notes` grouped by `mode`. Collapsed
 * groups (keys `folder:<path>`, `tag:<tag>`, `recent:<bucket>`) keep
 * their header and hide their notes (and, for folders, subfolders).
 */
export const layoutRows = (notes: NoteSummary[], mode: GroupMode, collapsed: ReadonlySet<string>, now: number): RowLayout => {
    const rows: VirtualRow[] = [];
    const offsets: number[] = [];
    let offset = 0;

    const pushNote = (note: NoteSummary, depth: number): void => {
        rows.push({kind: 'note', note, depth});
        offsets.push(offset);
        offset += noteRowHeight(note);
    };

    if (mode === 'folder') {
        const root = buildFolderTree(notes);

        // Root-level notes (no folder) render at depth 0 with no header
        // — a "/" bucket only added a click-target for nothing.
        for (const n of root.notes) pushNote(n, 0);

        const walk = (node: FolderNode, depth: number): void => {
            const groupKey = `folder:${node.path}`;
            const isCollapsed = collapsed.has(groupKey);
            const group: NoteGroup = {key: node.path, label: node.label, notes: node.notes};

            rows.push({kind: 'group', group, key: groupKey, isCollapsed, depth, totalCount: countRec(node)});
            offsets.push(offset);
            offset += GROUP_ROW_H;

            if (isCollapsed) return;

            // Subfolders first, then direct notes at this level — matches
            // conventional file-explorer ordering.
            for (const child of node.children) walk(child, depth + 1);
            for (const n of node.notes) pushNote(n, depth + 1);
        };

        for (const child of root.children) walk(child, 0);
        return {rows, offsets, height: offset};
    }

    for (const group of buildGroups(notes, mode, now)) {
        const groupKey = `${mode}:${group.key}`;
        const isCollapsed = collapsed.has(groupKey);

        rows.push({kind: 'group', group, key: groupKey, isCollapsed, depth: 0, totalCount: group.notes.length});
        offsets.push(offset);
        offset += GROUP_ROW_H;

        if (!isCollapsed) {
            for (const n of group.notes) pushNote(n, 0);
        }
    }

    return {rows, offsets, height: offset};
};

/** Index of the last row starting at or above `scrollTop` (binary search over `offsets`). */
export const firstRowAt = (offsets: readonly number[], scrollTop: number): number => {
    let lo = 0;
    let hi = offsets.length;

    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((offsets[mid] ?? 0) <= scrollTop) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }

    return Math.max(0, lo - 1);
};

export const folderOfNoteId = (id: string): string | null => {
    const slash = id.lastIndexOf('/');
    return slash === -1 ? null : id.slice(0, slash);
};
