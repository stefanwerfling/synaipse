/**
 * Public types of the service layer (plan P7 / D2). Re-exported from
 * Service.ts so existing imports keep working.
 */
import type {Frontmatter, NoteId, VaultEvent} from '@synaipse/core';
import type {PersonInput} from 'ngit';
import type {DuplicateCandidate} from '../Duplicates.js';
import type {InboxEntry} from '../Inbox.js';
import type {DecayCandidate} from '../MemoryDecay.js';

export interface SnapshotEntry {
    name: string;
    type: 'file' | 'dir';
    sha: string;
}

export interface IndexingStats {
    total: number;
    reindexed: number;
    removed: number;
    unchanged: number;
    /** Notes whose embedding failed and is still outstanding (retried on next write / start). */
    pending: number;
}

export interface RelatedNote {
    id: NoteId;
    title: string;
    score: number;
    reasons: string[];
}

export interface LinkSuggestion {
    a: NoteId;
    aTitle: string;
    b: NoteId;
    bTitle: string;
    score: number;
    reasons: string[];
    sharedTags?: string[];
}

export interface SuggestLinksOptions {
    limit?: number;
    minScore?: number;
    pathPrefix?: string;
}

export interface StaleNote {
    id: NoteId;
    title: string;
    tags: string[];
    mtime: number;
    lastAccessed?: number;
    accessCount: number;
    lastReferenced?: number;
    referencedCount: number;
    ageDays: number;
}

export interface StaleNotesOptions {
    olderThanDays?: number;
    pathPrefix?: string;
    limit?: number;
}

export interface ArchiveReport {
    candidates: DecayCandidate[];
    archived: NoteId[];
    failed: Array<{id: NoteId; error: string}>;
    dryRun: boolean;
}

export interface TodoItem {
    noteId: NoteId;
    title: string;
    line: number;
    text: string;
    done: boolean;
}

export type PrimerReason =
    | 'pinned'
    | 'recent_session'
    | 'project_decision'
    | 'referenced'
    | 'hot'
    | 'recent'
    | 'topic';

export interface PrimerEntry {
    id: NoteId;
    title: string;
    reason: PrimerReason;
    excerpt: string;
    tags: string[];
    mtime: number;
    backlinkCount: number;
    /** Times this note was named in a synaipse_log_session `references` list — explicit "was actually used", not just retrieved. */
    referencedCount: number;
}

export interface PrimeOptions {
    project?: string | null;
    limit?: number;
    topic?: string;
    includeCrawler?: boolean;
}

export interface PrimeResult {
    project: string | null;
    todoCount: number;
    todoSample: TodoItem[];
    context: PrimerEntry[];
    /**
     * Rough token estimate for the context + todoSample payload (≈ chars / 4).
     * Lets callers surface what loading this bundle costs in Claude's context window.
     * Not a precise tokenizer — order-of-magnitude indicator.
     */
    tokenEstimate: number;
}

export interface UpdateNoteInput {
    content?: string;
    frontmatterPatch?: Frontmatter;
    /** Only apply when the note still has this hash (optimistic lock). */
    expectedHash?: string;
}

/**
 * Guards for a write (plan P8 / B4). `mode`: `create` fails when the note
 * exists, `overwrite` when it does not, `upsert` (default) never.
 * `expectedHash`: fail unless the note exists with exactly this hash.
 * A failed guard throws WriteConflictError and writes nothing.
 */
export interface WriteGuard {
    mode?: WriteMode;
    expectedHash?: string;
}

export type WriteMode = 'create' | 'overwrite' | 'upsert';

/** Extra search filters (plan P8 / B3), applied after ranking. */
export interface SearchFilter {
    /** Every one of these tags (without #). */
    tags?: readonly string[];
    /** Modified at or after this epoch-ms. */
    sinceMs?: number;
}

/** A note that left the vault, from the version history. */
export interface RemovedNote {
    id: NoteId;
    /** epoch-ms of the commit. */
    at: number;
    how: 'deleted' | 'archived';
}

/** Which inbox entry: the text tells entries of the same minute apart. */
export interface InboxEntryRef {
    inbox: NoteId;
    time: string;
    text: string;
}

/** Where a promoted entry goes: an existing note, or a new one (title + project-relative path). */
export type InboxTarget = {id: NoteId} | {newTitle: string; newPath?: string};

/** One inbox entry with where its knowledge could go (plan P8 / B4). */
export interface InboxCandidate extends InboxEntry {
    /** Notes that already say this: the entry can be dropped. */
    alreadyIn: DuplicateCandidate[];
    /** Curated notes on the same topic to merge it into, best first. */
    targets: Array<{id: NoteId; title: string}>;
}

export interface ProjectOpts {
    project?: string | null;
    gitAuthor?: PersonInput;
    extraTags?: readonly string[];
}

export interface NoteHistoryEntry {
    sha: string;
    message: string;
    author: {name: string; email: string; date: string};
    parents: string[];
}

export type VaultChangeListener = (event: VaultEvent & {noteId: NoteId}) => void;
