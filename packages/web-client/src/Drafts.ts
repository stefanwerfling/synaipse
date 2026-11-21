import {defineMessages} from './I18n.js';
import {keysWithPrefix, readItem, removeItem, writeItem} from './LocalStore.js';

/**
 * Local-only unsaved-edit persistence. When the Editor detects a change
 * it writes a snapshot here (debounced); NotesPanel shows a ● marker on
 * notes that have a draft. Drafts are cleared on successful save and
 * survive tab switches / cancels so the user can resume.
 */
const t = defineMessages('drafts', {
    justNow: 'just now',
    minutes: '{count} min ago',
    hours: '{count} h ago',
    yesterday: 'yesterday',
    days: '{count} days ago'
});

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
        const raw = readItem(key(noteId));
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

// Quota / disabled storage: best-effort, silent.
export const writeDraft = (noteId: string, draft: EditorDraft): void => writeItem(key(noteId), JSON.stringify(draft));

export const clearDraft = (noteId: string): void => removeItem(key(noteId));

export const listDraftIds = (): Set<string> => new Set(keysWithPrefix(KEY_PREFIX));

/**
 * "3 min ago" / "2h ago" / "yesterday". Deliberately coarse — the user
 * only needs to gauge "recent vs stale" when deciding whether to restore.
 */
export const formatDraftAge = (savedAt: number, now: number = Date.now()): string => {
    const delta = Math.max(0, now - savedAt);
    const min = 60_000;
    const hour = 60 * min;
    const day = 24 * hour;

    if (delta < min) return t('justNow');
    if (delta < hour) return t('minutes', {count: Math.floor(delta / min)});
    if (delta < day) return t('hours', {count: Math.floor(delta / hour)});
    if (delta < 2 * day) return t('yesterday');
    return t('days', {count: Math.floor(delta / day)});
};