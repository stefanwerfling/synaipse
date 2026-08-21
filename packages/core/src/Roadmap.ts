/**
 * Per-project roadmap model. A roadmap is an arbitrarily nested tree of
 * implementation steps that an AI (via MCP) plans, evaluates and links to
 * notes. It is persisted vault-natively as one markdown note per project
 * (`Memory/<project>/_roadmap.md`): the step tree is the source of truth in
 * frontmatter under `roadmap:`, the body is an auto-rendered table + mermaid
 * diagram regenerated on every write.
 *
 * This module is pure (no I/O) so it is unit-testable in isolation and safe to
 * import into the browser bundle. Filesystem access lives in
 * `@synaipse/service`'s Roadmap module.
 */

export type RoadmapStatus =
    | 'backlog'
    | 'planned'
    | 'in_progress'
    | 'ai_active'
    | 'review'
    | 'blocked'
    | 'done'
    | 'cancelled';

export const ROADMAP_STATUSES: readonly RoadmapStatus[] = [
    'backlog',
    'planned',
    'in_progress',
    'ai_active',
    'review',
    'blocked',
    'done',
    'cancelled'
] as const;

export type RoadmapOwner = 'ai' | 'human';
export type RoadmapPriority = 'low' | 'med' | 'high';

/** A single audit entry appended when a step is mutated. */
export interface RoadmapEvent {
    /** ISO timestamp. */
    at: string;
    /** Who made the change (token label, git author, or "human"). */
    who: string;
    /** Short human-readable description of the change. */
    what: string;
}

export interface RoadmapStep {
    /** Stable hierarchical id, e.g. "2.3.1". Assigned by the caller/tool. */
    id: string;
    title: string;
    status: RoadmapStatus;
    /** Planned implementation time in hours (leaf estimate). */
    plannedHours?: number;
    /** Actual time spent in hours (leaf value; parents roll up). */
    actualHours?: number;
    owner?: RoadmapOwner;
    priority?: RoadmapPriority;
    /** 0..100. On parents this is derived from children by {@link rollup}. */
    progress?: number;
    /** Wikilink targets or note paths linked to this step. */
    noteLinks?: string[];
    /** Step ids this step depends on; open deps flip the step to 'blocked'. */
    dependsOn?: string[];
    /** Definition of done the AI checks against. */
    acceptance?: string;
    /** AI evaluation / rationale / remaining-estimate ("auswerten"). */
    evaluation?: string;
    /** Per-step activity log, newest last, capped by {@link ACTIVITY_CAP}. */
    activity?: RoadmapEvent[];
    /**
     * Soft-delete marker. A deleted step is never removed from the tree: it is
     * kept in the frontmatter (so nothing is lost), excluded from roll-up /
     * summary / rendered body, and hidden in the UI unless "show deleted" is on.
     * Deleting/restoring cascades to descendants (see {@link setStepDeleted}).
     */
    deleted?: boolean;
    children?: RoadmapStep[];
}

export interface RoadmapActive {
    /** Id of the step the AI is currently working on. */
    stepId: string;
    /** ISO timestamp the cursor was set. */
    since: string;
    /** Token label / actor that claimed the cursor. */
    token?: string;
}

export interface Roadmap {
    project: string;
    /** ISO timestamp of the last mutation. */
    updatedAt: string;
    /** Live cursor: at most one step is 'ai_active' at a time. */
    active?: RoadmapActive | null;
    steps: RoadmapStep[];
}

/** Max activity entries kept per step (older ones are dropped on append). */
export const ACTIVITY_CAP = 20;

const isStatus = (value: unknown): value is RoadmapStatus =>
    typeof value === 'string' && (ROADMAP_STATUSES as readonly string[]).includes(value);

/** Statuses that count as "not yet finished" for dependency gating. */
const OPEN_STATUSES: ReadonlySet<RoadmapStatus> = new Set<RoadmapStatus>([
    'backlog',
    'planned',
    'in_progress',
    'ai_active',
    'review',
    'blocked'
]);

const round1 = (n: number): number => Math.round(n * 10) / 10;

const isLeaf = (step: RoadmapStep): boolean => !step.children || step.children.length === 0;

// ---------------------------------------------------------------------------
// Tree traversal helpers
// ---------------------------------------------------------------------------

/** Depth-first search for a step by id. Returns the node or null. */
export const findStep = (steps: readonly RoadmapStep[], id: string): RoadmapStep | null => {
    for (const step of steps) {
        if (step.id === id) {
            return step;
        }
        if (step.children) {
            const hit = findStep(step.children, id);
            if (hit) {
                return hit;
            }
        }
    }
    return null;
};

/** Iterate every step in the tree, depth-first (parent before children). */
export const walkSteps = (
    steps: readonly RoadmapStep[],
    visit: (step: RoadmapStep, depth: number) => void,
    depth = 0
): void => {
    for (const step of steps) {
        visit(step, depth);
        if (step.children) {
            walkSteps(step.children, visit, depth + 1);
        }
    }
};

/** Flat list of every step id in the tree. */
export const allStepIds = (steps: readonly RoadmapStep[]): string[] => {
    const ids: string[] = [];
    walkSteps(steps, (s) => ids.push(s.id));
    return ids;
};

/**
 * Insert or replace a step under `parentId` (or at the root when parentId is
 * null/undefined). Existing children of a replaced step are preserved unless
 * the incoming step carries its own `children`. Returns a new step array
 * (does not mutate the input).
 */
export const upsertStep = (
    steps: readonly RoadmapStep[],
    step: RoadmapStep,
    parentId?: string | null
): RoadmapStep[] => {
    // Replace in place if the id already exists anywhere in the tree.
    const replaceExisting = (list: readonly RoadmapStep[]): {list: RoadmapStep[]; found: boolean} => {
        let found = false;
        const next = list.map((existing) => {
            if (existing.id === step.id) {
                found = true;
                const children = step.children ?? existing.children;
                const merged: RoadmapStep = {...existing, ...step};
                if (children !== undefined) {
                    merged.children = children;
                } else {
                    delete merged.children;
                }
                return merged;
            }
            if (existing.children) {
                const inner = replaceExisting(existing.children);
                if (inner.found) {
                    found = true;
                    return {...existing, children: inner.list};
                }
            }
            return existing;
        });
        return {list: next, found};
    };

    const replaced = replaceExisting(steps);
    if (replaced.found) {
        return replaced.list;
    }

    // Not found → append under the requested parent (or root).
    if (parentId === undefined || parentId === null) {
        return [...steps, step];
    }

    return steps.map((existing) => {
        if (existing.id === parentId) {
            return {...existing, children: [...(existing.children ?? []), step]};
        }
        if (existing.children) {
            return {...existing, children: upsertStep(existing.children, step, parentId)};
        }
        return existing;
    });
};

/**
 * Remove a step (and its subtree) by id. Returns a new step array.
 *
 * NOTE: this is a HARD delete — the step vanishes from the frontmatter and is
 * only recoverable from ngit history. Prefer {@link setStepDeleted} for the
 * user-facing "delete" path, which is a reversible soft-delete.
 */
export const removeStep = (steps: readonly RoadmapStep[], id: string): RoadmapStep[] => {
    const out: RoadmapStep[] = [];
    for (const step of steps) {
        if (step.id === id) {
            continue;
        }
        out.push(step.children ? {...step, children: removeStep(step.children, id)} : step);
    }
    return out;
};

/**
 * Move a step (with its whole subtree) to a new parent, or to the root when
 * `newParentId` is null. `position` places it among its new siblings (0-based;
 * out-of-range or omitted → appended at the end). This is the reparent/reorder
 * primitive the roadmap tool lacks otherwise — {@link upsertStep} replaces an
 * existing id in place and never relocates it.
 *
 * Guards (each throws, leaving the tree untouched):
 *  - unknown `id`
 *  - unknown `newParentId`
 *  - moving a step onto itself or onto one of its own descendants (would
 *    detach the subtree from the tree — a cycle).
 *
 * Returns a new step array; the input is not mutated. The moved node keeps its
 * id — ids are labels, not positions, so a "5.20" living under "5" is fine.
 */
export const moveStep = (
    steps: readonly RoadmapStep[],
    id: string,
    newParentId: string | null,
    position?: number
): RoadmapStep[] => {
    const node = findStep(steps, id);
    if (node === null) {
        throw new Error(`move: step "${id}" not found`);
    }
    if (newParentId !== null) {
        if (newParentId === id) {
            throw new Error(`move: cannot move step "${id}" under itself`);
        }
        if (findStep(steps, newParentId) === null) {
            throw new Error(`move: parent "${newParentId}" not found`);
        }
        // Reject moving onto a descendant — that would orphan the subtree.
        const descendantIds = new Set<string>();
        walkSteps(node.children ?? [], (s) => descendantIds.add(s.id));
        if (descendantIds.has(newParentId)) {
            throw new Error(`move: cannot move step "${id}" under its own descendant "${newParentId}"`);
        }
    }

    // Detach (subtree travels with the node), then splice into the target list.
    const detached = removeStep(steps, id);

    const insertInto = (list: readonly RoadmapStep[]): RoadmapStep[] => {
        const next = [...list];
        const at = position === undefined || !Number.isFinite(position)
            ? next.length
            : Math.max(0, Math.min(Math.trunc(position), next.length));
        next.splice(at, 0, node);
        return next;
    };

    if (newParentId === null) {
        return insertInto(detached);
    }
    return detached.map(function relocate(step): RoadmapStep {
        if (step.id === newParentId) {
            return {...step, children: insertInto(step.children ?? [])};
        }
        return step.children ? {...step, children: step.children.map(relocate)} : step;
    });
};

// ---------------------------------------------------------------------------
// Soft-delete
// ---------------------------------------------------------------------------

/** Set/clear `deleted` on a step and its entire subtree. Returns a new tree. */
const markSubtreeDeleted = (step: RoadmapStep, deleted: boolean): RoadmapStep => {
    const next: RoadmapStep = {...step};
    if (deleted) next.deleted = true;
    else delete next.deleted;
    if (step.children) next.children = step.children.map((c) => markSubtreeDeleted(c, deleted));
    return next;
};

/**
 * Soft-delete (or restore) a step by id. The step is never removed from the
 * tree — only its `deleted` flag flips, cascading to all descendants so a
 * hidden parent never leaves visible orphans. Returns a new step array; a
 * missing id is a no-op.
 */
export const setStepDeleted = (
    steps: readonly RoadmapStep[],
    id: string,
    deleted: boolean
): RoadmapStep[] =>
    steps.map((step) => {
        if (step.id === id) {
            return markSubtreeDeleted(step, deleted);
        }
        return step.children ? {...step, children: setStepDeleted(step.children, id, deleted)} : step;
    });

/** New tree with every soft-deleted step (and its subtree) pruned. For display/roll-up. */
export const withoutDeleted = (steps: readonly RoadmapStep[]): RoadmapStep[] =>
    steps
        .filter((s) => s.deleted !== true)
        .map((s) => (s.children ? {...s, children: withoutDeleted(s.children)} : s));

/** True when any step in the tree is soft-deleted. */
export const hasDeleted = (steps: readonly RoadmapStep[]): boolean => {
    let found = false;
    walkSteps(steps, (s) => {
        if (s.deleted === true) found = true;
    });
    return found;
};

/** Union two activity logs, dedupe by (at|who|what), sort ascending, cap. */
const mergeActivity = (a: readonly RoadmapEvent[], b?: readonly RoadmapEvent[]): RoadmapEvent[] => {
    const seen = new Set<string>();
    const out: RoadmapEvent[] = [];
    for (const e of [...a, ...(b ?? [])]) {
        const key = `${e.at}|${e.who}|${e.what}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e);
    }
    out.sort((x, y) => x.at.localeCompare(y.at));
    return out.slice(-ACTIVITY_CAP);
};

/**
 * Reconcile a full-tree roadmap replacement against the current tree so a
 * replace can never silently lose data — the incident this guards against was a
 * stale full-tree `synaipse_roadmap_plan` call that wiped every step's activity
 * history and dropped steps it happened to omit. Two guarantees:
 *
 *  1. **Activity is merged by id.** An incoming step that omits (or has a
 *     shorter) `activity` log keeps the audit history the current tree recorded.
 *  2. **Missing steps are soft-deleted, not dropped.** Any step present in the
 *     current tree but absent from the incoming tree is carried over with
 *     `deleted: true` (hidden, reversible) under its original parent when that
 *     parent survives, else at the root.
 *
 * Returns the reconciled step array to persist.
 */
export const reconcilePlan = (
    current: readonly RoadmapStep[],
    next: readonly RoadmapStep[]
): RoadmapStep[] => {
    const currentById = new Map<string, RoadmapStep>();
    const parentOf = new Map<string, string | null>();
    const indexCurrent = (steps: readonly RoadmapStep[], parentId: string | null): void => {
        for (const s of steps) {
            currentById.set(s.id, s);
            parentOf.set(s.id, parentId);
            if (s.children) indexCurrent(s.children, s.id);
        }
    };
    indexCurrent(current, null);

    const nextIds = new Set(allStepIds(next));

    // 1. Merge activity logs by id into the incoming tree.
    const mergeActivityInto = (steps: readonly RoadmapStep[]): RoadmapStep[] =>
        steps.map((s) => {
            const prev = currentById.get(s.id);
            const merged: RoadmapStep = prev?.activity
                ? {...s, activity: mergeActivity(prev.activity, s.activity)}
                : {...s};
            if (s.children) merged.children = mergeActivityInto(s.children);
            return merged;
        });
    let result = mergeActivityInto(next);

    // 2. Carry over vanished steps as soft-deleted subtrees. Iterating the DFS
    //    parent-before-child map, we graft only the top-most missing node of
    //    each vanished subtree; its descendants ride along via markSubtreeDeleted.
    for (const [id, step] of currentById) {
        if (nextIds.has(id)) continue;
        const parentId = parentOf.get(id) ?? null;
        if (parentId !== null && !nextIds.has(parentId)) continue; // rides along with a carried ancestor
        const graftParent = parentId !== null && nextIds.has(parentId) ? parentId : null;
        result = upsertStep(result, markSubtreeDeleted(step, true), graftParent);
    }
    return result;
};

// ---------------------------------------------------------------------------
// Derived-value passes
// ---------------------------------------------------------------------------

/**
 * Recompute parent `plannedHours`, `actualHours` and `progress` from their
 * children, bottom-up. Leaf values are preserved; a parent's planned/actual is
 * the sum of its descendants' leaf values, and its progress is the leaf-count
 * weighted average of child progress (a done leaf counts as 100). Returns a new
 * tree (does not mutate).
 */
export const rollup = (steps: readonly RoadmapStep[]): RoadmapStep[] =>
    steps.map((step) => {
        if (isLeaf(step)) {
            const progress = step.progress ?? (step.status === 'done' ? 100 : 0);
            return {...step, progress};
        }

        const children = rollup(step.children ?? []);

        let planned = 0;
        let actual = 0;
        let progressSum = 0;
        let leafCount = 0;

        // Soft-deleted steps are kept in the tree but never contribute to a
        // parent's rolled-up hours/progress.
        walkSteps(withoutDeleted(children), (child) => {
            if (!isLeaf(child)) {
                return;
            }
            leafCount += 1;
            planned += child.plannedHours ?? 0;
            actual += child.actualHours ?? 0;
            progressSum += child.progress ?? (child.status === 'done' ? 100 : 0);
        });

        return {
            ...step,
            children,
            plannedHours: round1(planned),
            actualHours: round1(actual),
            progress: leafCount === 0 ? (step.progress ?? 0) : Math.round(progressSum / leafCount)
        };
    });

/**
 * Flip any step with an unsatisfied `dependsOn` to 'blocked', and lift a step
 * back out of 'blocked' once all its dependencies are done/cancelled. Steps
 * without dependencies are untouched. Must run after any status change.
 */
export const applyDependencies = (roadmap: Roadmap): Roadmap => {
    const statusById = new Map<string, RoadmapStatus>();
    walkSteps(roadmap.steps, (s) => statusById.set(s.id, s.status));

    const depOpen = (dep: string): boolean => {
        const st = statusById.get(dep);
        // Unknown dependency ids are treated as open (safer: keeps it blocked).
        return st === undefined ? true : OPEN_STATUSES.has(st);
    };

    const rewrite = (steps: readonly RoadmapStep[]): RoadmapStep[] =>
        steps.map((step) => {
            const next: RoadmapStep = step.children ? {...step, children: rewrite(step.children)} : {...step};
            const deps = step.dependsOn ?? [];
            if (deps.length === 0) {
                return next;
            }
            const blocked = deps.some(depOpen);
            if (blocked && next.status !== 'blocked' && next.status !== 'done' && next.status !== 'cancelled') {
                next.status = 'blocked';
            } else if (!blocked && next.status === 'blocked') {
                next.status = 'planned';
            }
            return next;
        });

    return {...roadmap, steps: rewrite(roadmap.steps)};
};

/**
 * Set the live "AI is working here" cursor to `stepId`: that step becomes
 * 'ai_active' and any other step currently 'ai_active' drops back to
 * 'in_progress'. Passing null clears the cursor (the active step drops to
 * 'in_progress'). Returns a new roadmap; unknown ids are a no-op cursor-wise.
 */
export const setActive = (
    roadmap: Roadmap,
    stepId: string | null,
    at: string,
    token?: string
): Roadmap => {
    const target = stepId === null ? null : findStep(roadmap.steps, stepId);

    const rewrite = (steps: readonly RoadmapStep[]): RoadmapStep[] =>
        steps.map((step) => {
            let status = step.status;
            if (step.status === 'ai_active' && step.id !== stepId) {
                status = 'in_progress';
            }
            if (target !== null && step.id === stepId) {
                status = 'ai_active';
            }
            return step.children
                ? {...step, status, children: rewrite(step.children)}
                : {...step, status};
        });

    return {
        ...roadmap,
        active: target === null ? null : {stepId: target.id, since: at, ...(token !== undefined ? {token} : {})},
        steps: rewrite(roadmap.steps)
    };
};

/** Append an activity entry to a step, capped at {@link ACTIVITY_CAP}. */
export const appendActivity = (step: RoadmapStep, event: RoadmapEvent): RoadmapStep => {
    const log = [...(step.activity ?? []), event];
    return {...step, activity: log.slice(-ACTIVITY_CAP)};
};

// ---------------------------------------------------------------------------
// Aggregate summary (for KPI tiles / list view)
// ---------------------------------------------------------------------------

export interface RoadmapSummary {
    project: string;
    totalSteps: number;
    doneSteps: number;
    blockedSteps: number;
    plannedHours: number;
    actualHours: number;
    /** Overall progress 0..100 (leaf-count weighted). */
    progress: number;
    activeStepId: string | null;
    updatedAt: string;
}

export const summarize = (roadmap: Roadmap): RoadmapSummary => {
    // Soft-deleted steps are excluded from every KPI.
    const rolled = withoutDeleted(rollup(roadmap.steps));
    let total = 0;
    let done = 0;
    let blocked = 0;
    let planned = 0;
    let actual = 0;
    let progressSum = 0;
    let leafCount = 0;

    walkSteps(rolled, (step) => {
        total += 1;
        if (step.status === 'done') done += 1;
        if (step.status === 'blocked') blocked += 1;
        if (isLeaf(step)) {
            leafCount += 1;
            planned += step.plannedHours ?? 0;
            actual += step.actualHours ?? 0;
            progressSum += step.progress ?? (step.status === 'done' ? 100 : 0);
        }
    });

    return {
        project: roadmap.project,
        totalSteps: total,
        doneSteps: done,
        blockedSteps: blocked,
        plannedHours: round1(planned),
        actualHours: round1(actual),
        progress: leafCount === 0 ? 0 : Math.round(progressSum / leafCount),
        activeStepId: roadmap.active?.stepId ?? null,
        updatedAt: roadmap.updatedAt
    };
};

// ---------------------------------------------------------------------------
// Parsing (frontmatter → Roadmap), defensive like extractTypedLinks
// ---------------------------------------------------------------------------

const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const asNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const asStrArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

const parseActivity = (v: unknown): RoadmapEvent[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out: RoadmapEvent[] = [];
    for (const e of v) {
        if (e === null || typeof e !== 'object') continue;
        const c = e as Record<string, unknown>;
        const at = asStr(c.at);
        const who = asStr(c.who);
        const what = asStr(c.what);
        if (at && who && what) out.push({at, who, what});
    }
    return out.length > 0 ? out : undefined;
};

const parseStep = (raw: unknown): RoadmapStep | null => {
    if (raw === null || typeof raw !== 'object') return null;
    const c = raw as Record<string, unknown>;
    const id = asStr(c.id);
    const title = asStr(c.title);
    if (!id || !title) return null;

    const status: RoadmapStatus = isStatus(c.status) ? c.status : 'planned';
    const step: RoadmapStep = {id, title, status};

    const planned = asNum(c.plannedHours);
    if (planned !== undefined) step.plannedHours = planned;
    const actual = asNum(c.actualHours);
    if (actual !== undefined) step.actualHours = actual;
    if (c.owner === 'ai' || c.owner === 'human') step.owner = c.owner;
    if (c.priority === 'low' || c.priority === 'med' || c.priority === 'high') step.priority = c.priority;
    const progress = asNum(c.progress);
    if (progress !== undefined) step.progress = Math.max(0, Math.min(100, progress));
    const noteLinks = asStrArr(c.noteLinks);
    if (noteLinks) step.noteLinks = noteLinks;
    const dependsOn = asStrArr(c.dependsOn);
    if (dependsOn) step.dependsOn = dependsOn;
    const acceptance = asStr(c.acceptance);
    if (acceptance) step.acceptance = acceptance;
    const evaluation = asStr(c.evaluation);
    if (evaluation) step.evaluation = evaluation;
    const activity = parseActivity(c.activity);
    if (activity) step.activity = activity;
    if (c.deleted === true) step.deleted = true;

    if (Array.isArray(c.children)) {
        const children = c.children.map(parseStep).filter((s): s is RoadmapStep => s !== null);
        if (children.length > 0) step.children = children;
    }

    return step;
};

/**
 * Build a Roadmap from a note's frontmatter `roadmap` payload. Malformed steps
 * are silently skipped (mirrors {@link extractTypedLinks}). Returns null when
 * there is no roadmap payload at all.
 */
export const parseRoadmap = (project: string, frontmatter: Record<string, unknown>): Roadmap | null => {
    const raw = frontmatter.roadmap;
    if (raw === null || typeof raw !== 'object') {
        return null;
    }
    const c = raw as Record<string, unknown>;
    const steps = Array.isArray(c.steps)
        ? c.steps.map(parseStep).filter((s): s is RoadmapStep => s !== null)
        : [];

    let active: RoadmapActive | null = null;
    if (c.active && typeof c.active === 'object') {
        const a = c.active as Record<string, unknown>;
        const stepId = asStr(a.stepId);
        const since = asStr(a.since);
        if (stepId && since) {
            active = {stepId, since, ...(asStr(a.token) ? {token: a.token as string} : {})};
        }
    }

    return {
        project,
        updatedAt: asStr(c.updatedAt) ?? asStr(frontmatter.updated) ?? '',
        active,
        steps
    };
};

/**
 * Serialize a Roadmap into a plain object suitable for frontmatter under the
 * `roadmap:` key. Undefined optional fields are dropped so the YAML stays lean.
 */
export const serializeRoadmap = (roadmap: Roadmap): Record<string, unknown> => ({
    updatedAt: roadmap.updatedAt,
    active: roadmap.active ?? null,
    steps: roadmap.steps
});

// ---------------------------------------------------------------------------
// Body rendering (human-readable table + mermaid)
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<RoadmapStatus, string> = {
    backlog: 'Backlog',
    planned: 'Geplant',
    in_progress: 'In Arbeit',
    ai_active: 'KI aktiv',
    review: 'Review',
    blocked: 'Blockiert',
    done: 'Fertig',
    cancelled: 'Abgebrochen'
};

const hours = (n: number | undefined): string =>
    n === undefined ? '—' : `${round1(n).toLocaleString('de-DE')} h`;

const AUTOGEN_MARKER =
    '<!-- ⚠ Auto-generiert aus dem `roadmap:`-Frontmatter durch Synaipse. Nicht von Hand editieren — Änderungen werden beim nächsten Roadmap-Write überschrieben. -->';

/**
 * Render the human-readable body of `_roadmap.md`: a nested table plus a
 * mermaid flow of the top-level phases. Regenerated on every write.
 */
export const renderRoadmapMarkdown = (roadmap: Roadmap): string => {
    // Soft-deleted steps stay in the frontmatter but are hidden from the body.
    const rolled = withoutDeleted(rollup(roadmap.steps));
    const deletedCount = allStepIds(roadmap.steps).length - allStepIds(rolled).length;
    const s = summarize(roadmap);

    const lines: string[] = [];
    lines.push(AUTOGEN_MARKER);
    lines.push('');
    lines.push(`# Roadmap: ${roadmap.project}`);
    lines.push('');
    lines.push(
        `> **${s.progress}%** fertig · ${s.doneSteps}/${s.totalSteps} Schritte · ` +
            `geplant ${hours(s.plannedHours)} · umgesetzt ${hours(s.actualHours)}` +
            (s.blockedSteps > 0 ? ` · ⛔ ${s.blockedSteps} blockiert` : '') +
            (deletedCount > 0 ? ` · 🗑 ${deletedCount} gelöscht (ausgeblendet)` : '')
    );
    if (roadmap.active) {
        const step = findStep(rolled, roadmap.active.stepId);
        lines.push('');
        lines.push(`> 🟣 **KI arbeitet gerade an:** ${roadmap.active.stepId}${step ? ` — ${step.title}` : ''}`);
    }
    lines.push('');
    lines.push('| # | Schritt | Status | Owner | Geplant | Umgesetzt | Fortschritt | Notizen |');
    lines.push('|---|---|---|---|--:|--:|--:|---|');

    walkSteps(rolled, (step, depth) => {
        const indent = depth > 0 ? '&nbsp;'.repeat(depth * 3) + '↳ ' : '';
        const notes = (step.noteLinks ?? []).map((n) => `[[${n}]]`).join(' ');
        const owner = step.owner === 'ai' ? 'KI' : step.owner === 'human' ? 'Mensch' : '';
        lines.push(
            `| \`${step.id}\` | ${indent}${step.title} | ${STATUS_LABEL[step.status]} | ${owner} | ` +
                `${hours(step.plannedHours)} | ${hours(step.actualHours)} | ${step.progress ?? 0}% | ${notes} |`
        );
    });

    // Mermaid flow of top-level phases (kind=status-tinted classDef).
    lines.push('');
    lines.push('```mermaid');
    lines.push('flowchart LR');
    rolled.forEach((step, i) => {
        const safe = step.title.replace(/["\n]/g, ' ').slice(0, 40);
        lines.push(`  P${i}["${step.id} ${safe}"]`);
        if (i > 0) {
            lines.push(`  P${i - 1} --> P${i}`);
        }
    });
    lines.push('```');
    lines.push('');

    return lines.join('\n');
};
