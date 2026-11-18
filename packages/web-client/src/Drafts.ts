/**
 * Local-only unsaved-edit persistence. When the Editor detects a change
 * it writes a snapshot here (debounced); NotesPanel shows a ● marker on
 * notes that have a draft. Drafts are cleared on successful save and
 * survive tab switches / cancels so the user can resume.
 */
export interface EditorDraft {
    title: string;
    tags: string;
    content: string;
    savedAt: number;
}

const KEY_PREFIX = 'synaipse.editor.draft:';

const key = (noteId: string): string => `${KEY_PREFIX}${noteId}`;

export const readDraft = (noteId: string): EditorDraft | null => {
    try {
        const raw = window.localStorage.getItem(key(noteId));
        if (raw === null) return null;
        const parsed = JSON.parse(raw) as EditorDraft;
        if (typeof parsed.content !== 'string') return null;
        if (typeof parsed.title !== 'string') return null;
        if (typeof parsed.tags !== 'string') return null;
        if (typeof parsed.savedAt !== 'number') return null;
        return parsed;
    } catch {
        return null;
    }
};

export const writeDraft = (noteId: string, draft: EditorDraft): void => {
    try {
        window.localStorage.setItem(key(noteId), JSON.stringify(draft));
    } catch {
        // Quota / corrupted / disabled storage — best-effort, silent.
    }
};

export const clearDraft = (noteId: string): void => {
    try {
        window.localStorage.removeItem(key(noteId));
    } catch {
        // ignore
    }
};

export const listDraftIds = (): Set<string> => {
    const ids = new Set<string>();

    try {
        for (let i = 0; i < window.localStorage.length; i += 1) {
            const k = window.localStorage.key(i);
            if (k !== null && k.startsWith(KEY_PREFIX)) {
                ids.add(k.slice(KEY_PREFIX.length));
            }
        }
    } catch {
        // localStorage unavailable — no drafts to advertise.
    }

    return ids;
};

/**
 * "3 min ago" / "2h ago" / "yesterday". Deliberately coarse — the user
 * only needs to gauge "recent vs stale" when deciding whether to restore.
 */
export const formatDraftAge = (savedAt: number, now: number = Date.now()): string => {
    const delta = Math.max(0, now - savedAt);
    const min = 60_000;
    const hour = 60 * min;
    const day = 24 * hour;

    if (delta < min) return 'just now';
    if (delta < hour) return `${Math.floor(delta / min)} min ago`;
    if (delta < day) return `${Math.floor(delta / hour)} h ago`;
    if (delta < 2 * day) return 'yesterday';
    return `${Math.floor(delta / day)} days ago`;
};