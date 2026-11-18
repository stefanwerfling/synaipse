import {extractTypedLinks, type Frontmatter, type NoteId, type SearchHit} from '@synaipse/core';

/**
 * How current a note is (plan P8 / B4): superseded by another note, past
 * its `valid_until`, or written with low `confidence`. Search ranks such
 * notes lower, puts the successor of a superseded note in its place and
 * marks the hit, so an agent does not answer from an outdated decision.
 */

/** Ranking weight of a note that another note supersedes. */
export const SUPERSEDED_WEIGHT = 0.25;
/** Ranking weight of a note whose `valid_until` has passed. */
export const EXPIRED_WEIGHT = 0.3;

export interface KnowledgeNote {
    id: NoteId;
    title: string;
    mtime: number;
    frontmatter: Frontmatter;
}

export interface KnowledgeState {
    /** Ranking multiplier in (0, 1]. */
    weight: number;
    /** The note that replaces this one (end of the chain), if any. */
    supersededBy?: NoteId;
    expired?: true;
    /** Only set when below 1. */
    confidence?: number;
}

/**
 * Targets a note declares as superseded: frontmatter `supersedes: [...]`
 * plus typed links `links: [{target, kind: supersedes}]`. Wikilink
 * brackets are stripped; resolution to an id is up to the caller.
 */
export const supersededTargets = (frontmatter: Frontmatter): string[] => {
    const raw = Array.isArray(frontmatter.supersedes) ? frontmatter.supersedes : [];
    const fromField = raw.filter((t): t is string => typeof t === 'string');
    const fromLinks = extractTypedLinks(frontmatter).filter((l) => l.kind === 'supersedes').map((l) => l.target);

    return [...fromField, ...fromLinks]
        .map((t) => t.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0]!.trim())
        .filter((t) => t.length > 0);
};

/**
 * Superseded note → its successor. When two notes supersede the same one,
 * the newer (mtime) wins. Chains (A → B → C) resolve to the last note;
 * notes in a cycle (A ↔ B: contradictory) count as not superseded.
 */
export const buildSuccessors = (
    notes: Iterable<KnowledgeNote>,
    resolve: (target: string) => NoteId | undefined
): Map<NoteId, NoteId> => {
    const direct = new Map<NoteId, {id: NoteId; mtime: number}>();

    for (const note of notes) {
        for (const target of supersededTargets(note.frontmatter)) {
            const old = resolve(target);
            if (old === undefined || old === note.id) continue;

            const current = direct.get(old);
            if (current === undefined || note.mtime > current.mtime) direct.set(old, {id: note.id, mtime: note.mtime});
        }
    }

    const out = new Map<NoteId, NoteId>();

    for (const old of direct.keys()) {
        const seen = new Set<NoteId>([old]);
        let last = direct.get(old)!.id;

        while (direct.has(last) && !seen.has(last)) {
            seen.add(last);
            last = direct.get(last)!.id;
        }

        if (last !== old) out.set(old, last);
    }

    return out;
};

/** `valid_until` as end of that day (UTC); YAML dates arrive as Date objects. */
const validUntilMs = (value: unknown): number | null => {
    if (value instanceof Date) return value.getTime() + 86_400_000 - 1;
    if (typeof value !== 'string' || value.trim() === '') return null;

    const text = value.trim();
    const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T23:59:59.999Z` : text);
    return Number.isNaN(ms) ? null : ms;
};

export const knowledgeStateOf = (
    note: KnowledgeNote,
    successors: ReadonlyMap<NoteId, NoteId>,
    now: number
): KnowledgeState => {
    const state: KnowledgeState = {weight: 1};
    const successor = successors.get(note.id);

    if (successor !== undefined) {
        state.supersededBy = successor;
        state.weight *= SUPERSEDED_WEIGHT;
    }

    const until = validUntilMs(note.frontmatter['valid_until']);
    if (until !== null && until < now) {
        state.expired = true;
        state.weight *= EXPIRED_WEIGHT;
    }

    const confidence = note.frontmatter.confidence;
    if (typeof confidence === 'number' && confidence >= 0 && confidence < 1) {
        state.confidence = confidence;
        state.weight *= 0.5 + 0.5 * confidence;
    }

    return state;
};

/** Superseded or expired: left out of the primer. */
export const isOutdated = (state: KnowledgeState): boolean => state.supersededBy !== undefined || state.expired === true;

export type AnnotatedHit = SearchHit & {supersededBy?: NoteId; expired?: true; confidence?: number};

/**
 * Re-rank hits by knowledge state: scores are multiplied by the weight,
 * hits are marked, and the successor of a superseded hit takes at least
 * the score the old note had, so it shows where the old one would have.
 * `hits` should be a little longer than `limit`, so demoted hits make
 * room for ones below the cut.
 */
export const applyKnowledgeState = (
    hits: readonly SearchHit[],
    limit: number,
    lookup: (id: NoteId) => KnowledgeNote | undefined,
    successors: ReadonlyMap<NoteId, NoteId>,
    now: number
): AnnotatedHit[] => {
    const byId = new Map<NoteId, AnnotatedHit>();
    const order: NoteId[] = [];

    const add = (hit: AnnotatedHit): void => {
        const existing = byId.get(hit.noteId);
        if (existing === undefined) {
            byId.set(hit.noteId, hit);
            order.push(hit.noteId);
        } else if (hit.score > existing.score) {
            byId.set(hit.noteId, {...existing, score: hit.score});
        }
    };

    for (const hit of hits) {
        const note = lookup(hit.noteId);
        const state = note === undefined ? {weight: 1} : knowledgeStateOf(note, successors, now);

        if (state.weight === 1) {
            add(hit);
            continue;
        }

        const marked: AnnotatedHit = {...hit, score: hit.score * state.weight};
        if (state.supersededBy !== undefined) marked.supersededBy = state.supersededBy;
        if (state.expired === true) marked.expired = true;
        if (state.confidence !== undefined) marked.confidence = state.confidence;
        if (hit.components !== undefined) {
            marked.components = {...hit.components, demote: (hit.components.demote ?? 1) * state.weight};
        }
        add(marked);

        const successor = state.supersededBy === undefined ? undefined : lookup(state.supersededBy);
        if (successor !== undefined) {
            const successorState = knowledgeStateOf(successor, successors, now);
            add({
                noteId: successor.id,
                path: successor.id,
                title: successor.title,
                score: hit.score * successorState.weight
            });
        }
    }

    // Stable: equal scores keep the incoming order.
    return order
        .map((id, index) => ({hit: byId.get(id)!, index}))
        .sort((a, b) => b.hit.score - a.hit.score || a.index - b.index)
        .slice(0, limit)
        .map((entry) => entry.hit);
};
