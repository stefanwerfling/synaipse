import type {Roadmap, RoadmapStatus, RoadmapStep} from '@synaipse/core';
import {
    ROADMAP_STATUSES,
    appendActivity,
    canonicalNoteLink,
    findStep,
    moveStep,
    parseRoadmap,
    reconcilePlan,
    resolveNoteRefTarget,
    setActive,
    setStepDeleted,
    summarize,
    upsertStep
} from '@synaipse/core';
import {getAuditTokenLabel, type SynaipseService} from '@synaipse/service';
import {asLimit, asString, ok, type ToolContext, type ToolHandler} from './Shared.js';

/** Who is mutating the roadmap — the auth token label, or "claude" in dev. */
const roadmapActor = (): string => getAuditTokenLabel() ?? 'claude';

/** Resolve the active project or throw a helpful error for roadmap tools. */
const requireRoadmapProject = (service: SynaipseService, ctx?: ToolContext): string => {
    const project = service.getProject(ctx?.project);
    if (project === null) {
        throw new Error(
            'No project context set. Roadmap tools operate per project — set one via the /mcp/<project> URL segment or the x-synaipse-project header.'
        );
    }
    return project;
};

const isRoadmapStatus = (value: unknown): value is RoadmapStatus =>
    typeof value === 'string' && (ROADMAP_STATUSES as readonly string[]).includes(value);

/**
 * Resolve free-form note references (titles / paths / ids) against the vault to
 * their canonical wikilink form, so a step/entry never stores a link that
 * points at no note. Refs that resolve to nothing are returned in `unresolved`
 * — callers reject the write instead of persisting a dead link.
 */
const resolveNoteLinks = (
    service: SynaipseService,
    refs: readonly string[]
): {resolved: string[]; unresolved: string[]} => {
    const targets = service.listNotes().map((n) => ({
        id: n.id,
        title: n.title,
        aliases: Array.isArray(n.frontmatter.aliases) ? n.frontmatter.aliases : []
    }));
    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const ref of refs) {
        const target = resolveNoteRefTarget(ref, targets);
        if (target === null) {
            unresolved.push(ref);
        } else {
            resolved.push(canonicalNoteLink(target));
        }
    }
    return {resolved, unresolved};
};

/** Apply an update_step field patch to a step, returning a new step. */
/** Reject a present-but-invalid enum value instead of silently ignoring it. */
const assertEnum = (args: Record<string, unknown>, field: string, allowed: readonly string[]): void => {
    const value = args[field];
    if (value !== undefined && value !== null && !(typeof value === 'string' && allowed.includes(value))) {
        throw new Error(`Invalid ${field} "${String(value)}" — expected one of: ${allowed.join(', ')}`);
    }
};

const patchStep = (step: RoadmapStep, args: Record<string, unknown>): RoadmapStep => {
    assertEnum(args, 'status', ROADMAP_STATUSES);
    assertEnum(args, 'owner', ['ai', 'human']);
    assertEnum(args, 'priority', ['low', 'med', 'high']);
    const next: RoadmapStep = {...step};
    if (typeof args.title === 'string' && args.title.length > 0) next.title = args.title;
    if (isRoadmapStatus(args.status)) next.status = args.status;
    if (typeof args.plannedHours === 'number') next.plannedHours = args.plannedHours;
    if (typeof args.actualHours === 'number') next.actualHours = args.actualHours;
    if (args.owner === 'ai' || args.owner === 'human') next.owner = args.owner;
    if (args.priority === 'low' || args.priority === 'med' || args.priority === 'high') next.priority = args.priority;
    if (typeof args.progress === 'number') next.progress = Math.max(0, Math.min(100, args.progress));
    if (typeof args.acceptance === 'string') next.acceptance = args.acceptance;
    if (typeof args.evaluation === 'string') next.evaluation = args.evaluation;
    if (Array.isArray(args.dependsOn)) {
        next.dependsOn = args.dependsOn.filter((d): d is string => typeof d === 'string');
    }
    return next;
};

/** Sanitize a caller-supplied step tree through the defensive core parser. */
const sanitizeSteps = (project: string, steps: unknown): RoadmapStep[] => {
    const parsed = parseRoadmap(project, {roadmap: {steps}});
    return parsed?.steps ?? [];
};

const roadmapResult = (roadmap: Roadmap): unknown => ({
    project: roadmap.project,
    summary: summarize(roadmap),
    active: roadmap.active,
    steps: roadmap.steps
});

interface StepOutline {
    id: string;
    title: string;
    status: RoadmapStep['status'];
    progress?: number;
    plannedHours?: number;
    actualHours?: number;
    children?: StepOutline[];
}

/** Tree skeleton without activity logs, texts or deleted steps — what a write needs to confirm. */
const outlineSteps = (steps: readonly RoadmapStep[]): StepOutline[] => steps
    .filter((step) => step.deleted !== true)
    .map((step) => {
        const children = outlineSteps(step.children ?? []);
        return {
            id: step.id,
            title: step.title,
            status: step.status,
            ...(step.progress !== undefined ? {progress: step.progress} : {}),
            ...(step.plannedHours !== undefined ? {plannedHours: step.plannedHours} : {}),
            ...(step.actualHours !== undefined ? {actualHours: step.actualHours} : {}),
            ...(children.length > 0 ? {children} : {})
        };
    });

/**
 * Result of tree-changing writes (plan/move/rollback): summary plus the
 * outline. Full step bodies with activity logs are only in roadmap_get —
 * echoing them after every write cost thousands of tokens per call.
 */
const roadmapWriteResult = (roadmap: Roadmap): Record<string, unknown> => ({
    project: roadmap.project,
    summary: summarize(roadmap),
    active: roadmap.active,
    steps: outlineSteps(roadmap.steps)
});

/** One step after update_step: its own fields, the latest activity entry, child count instead of the subtree. */
const stepResult = (step: RoadmapStep | null): unknown => {
    if (step === null) return null;
    const {children, activity, ...rest} = step;
    return {
        ...rest,
        ...(activity !== undefined && activity.length > 0 ? {activity: activity.slice(-1)} : {}),
        ...(children !== undefined && children.length > 0 ? {childCount: children.length} : {})
    };
};

/** Per-project roadmap planning (Memory/<project>/_roadmap.md). */
export const roadmapTools = (service: SynaipseService): ToolHandler[] => [
    {
        definition: {
            name: 'synaipse_roadmap_get',
            description: 'The active project\'s roadmap: step tree, live cursor and rolled-up summary; stepId returns just that subtree. Read before planning or updating.',
            inputSchema: {
                type: 'object',
                properties: {
                    stepId: {type: 'string'}
                }
            }
        },
        handle: async (args, ctx) => {
            const project = requireRoadmapProject(service, ctx);
            const roadmap = service.readRoadmap(project);
            const stepId = typeof args.stepId === 'string' ? args.stepId : null;
            if (stepId !== null) {
                const step = findStep(roadmap.steps, stepId);
                return {
                    response: ok({project, step, summary: summarize(roadmap)}),
                    event: {kind: 'list', touched: []}
                };
            }
            return {response: ok(roadmapResult(roadmap)), event: {kind: 'list', touched: []}};
        }
    },
    {
        definition: {
            name: 'synaipse_roadmap_plan',
            description: 'Plan the active project\'s roadmap. `steps` replaces the whole tree (non-destructive: activity merged by id, omitted steps soft-deleted); `step` (+ parentId) upserts one step — prefer it for incremental edits. Steps nest via children; hours/progress roll up; open dependsOn → blocked.',
            inputSchema: {
                type: 'object',
                properties: {
                    steps: {
                        type: 'array',
                        description: `Step: {id ("1", "1.2"), title, status, plannedHours?, actualHours?, owner? (ai|human), priority? (low|med|high), noteLinks?, dependsOn?, acceptance?, evaluation?, children?}. status: ${ROADMAP_STATUSES.join('|')}`,
                        items: {type: 'object'}
                    },
                    step: {type: 'object'},
                    parentId: {type: 'string', description: 'For `step`; omit for top level'}
                }
            }
        },
        handle: async (args, ctx) => {
            const project = requireRoadmapProject(service, ctx);
            const current = service.readRoadmap(project);

            let nextSteps: RoadmapStep[];
            if (Array.isArray(args.steps)) {
                // Full-tree replace is reconciled against the current tree: activity
                // logs are merged by id and steps the incoming tree omits are kept as
                // soft-deleted (hidden) rather than dropped. Guards against a stale
                // replace silently wiping history — see reconcilePlan.
                nextSteps = reconcilePlan(current.steps, sanitizeSteps(project, args.steps));
            } else if (args.step !== undefined && args.step !== null) {
                const [sanitized] = sanitizeSteps(project, [args.step]);
                if (sanitized === undefined) {
                    throw new Error('step is missing a valid id/title.');
                }
                const parentId = typeof args.parentId === 'string' ? args.parentId : null;
                nextSteps = upsertStep(current.steps, sanitized, parentId);
            } else {
                throw new Error('Provide either `steps` (full tree) or `step` (single upsert).');
            }

            const saved = await service.writeRoadmap({...current, steps: nextSteps});
            const noteId = `Memory/${project}/_roadmap.md`;
            return {
                response: ok(roadmapWriteResult(saved)),
                event: {kind: 'write', touched: [noteId]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_roadmap_move',
            description: 'Re-parent or re-order a step with its subtree (roadmap_plan cannot move). Omit newParentId for top level; position is the 0-based index among new siblings (default: append). Ids stay; cycles are rejected; undo via roadmap_rollback.',
            inputSchema: {
                type: 'object',
                properties: {
                    stepId: {type: 'string'},
                    newParentId: {type: 'string'},
                    position: {type: 'number'}
                },
                required: ['stepId']
            }
        },
        handle: async (args, ctx) => {
            const project = requireRoadmapProject(service, ctx);
            const stepId = asString(args.stepId, 'stepId');
            const newParentId = typeof args.newParentId === 'string' && args.newParentId.length > 0
                ? args.newParentId
                : null;
            const position = typeof args.position === 'number' ? args.position : undefined;
            const current = service.readRoadmap(project);
            // moveStep throws on unknown ids / cycles — surfaced as a tool error.
            const moved = moveStep(current.steps, stepId, newParentId, position);
            const logged = upsertStep(
                moved,
                appendActivity(findStep(moved, stepId) as RoadmapStep, {
                    at: new Date().toISOString(),
                    who: roadmapActor(),
                    what: `moved to ${newParentId === null ? 'top level' : `parent ${newParentId}`}`
                })
            );
            const saved = await service.writeRoadmap({...current, steps: logged});
            return {
                response: ok(roadmapWriteResult(saved)),
                event: {kind: 'write', touched: [`Memory/${project}/_roadmap.md`]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_roadmap_update_step',
            description: 'Patch one step; only passed fields change and an activity entry is appended. Use while working, e.g. status "review" plus what you did in evaluation. deleted:true soft-deletes (cascades, reversible).',
            inputSchema: {
                type: 'object',
                properties: {
                    stepId: {type: 'string'},
                    status: {type: 'string', enum: [...ROADMAP_STATUSES], description: 'New status.'},
                    title: {type: 'string'},
                    plannedHours: {type: 'number'},
                    actualHours: {type: 'number'},
                    progress: {type: 'number', minimum: 0, maximum: 100},
                    owner: {type: 'string', enum: ['ai', 'human']},
                    priority: {type: 'string', enum: ['low', 'med', 'high']},
                    acceptance: {type: 'string', description: 'Definition of done'},
                    evaluation: {type: 'string', description: 'Your assessment / remaining estimate'},
                    dependsOn: {type: 'array', items: {type: 'string'}},
                    deleted: {type: 'boolean'},
                    note: {type: 'string', description: 'Activity message (default: changed fields)'}
                },
                required: ['stepId']
            }
        },
        handle: async (args, ctx) => {
            const project = requireRoadmapProject(service, ctx);
            const stepId = asString(args.stepId, 'stepId');
            const current = service.readRoadmap(project);
            const existing = findStep(current.steps, stepId);
            if (existing === null) {
                throw new Error(`Step "${stepId}" not found in the ${project} roadmap.`);
            }
            const patched = patchStep(existing, args);
            const changed = Object.keys(args).filter((k) => k !== 'stepId' && k !== 'note');
            const message = typeof args.note === 'string' && args.note.length > 0
                ? args.note
                : `updated ${changed.join(', ') || 'step'}`;
            const logged = appendActivity(patched, {at: new Date().toISOString(), who: roadmapActor(), what: message});
            let nextSteps = upsertStep(current.steps, logged);
            // Soft-delete/restore cascades to sub-steps; steps are never hard-removed.
            if (typeof args.deleted === 'boolean') {
                nextSteps = setStepDeleted(nextSteps, stepId, args.deleted);
            }
            const saved = await service.writeRoadmap({...current, steps: nextSteps});
            return {
                response: ok({project, step: stepResult(findStep(saved.steps, stepId)), summary: summarize(saved)}),
                event: {kind: 'write', touched: [`Memory/${project}/_roadmap.md`]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_roadmap_set_active',
            description: 'Set the live "AI is working here" cursor to a step (status ai_active; the previous one returns to in_progress). Omit stepId to clear.',
            inputSchema: {
                type: 'object',
                properties: {
                    stepId: {type: 'string'}
                }
            }
        },
        handle: async (args, ctx) => {
            const project = requireRoadmapProject(service, ctx);
            const current = service.readRoadmap(project);
            const stepId = typeof args.stepId === 'string' && args.stepId.length > 0 ? args.stepId : null;
            if (stepId !== null && findStep(current.steps, stepId) === null) {
                throw new Error(`Step "${stepId}" not found in the ${project} roadmap.`);
            }
            const actor = roadmapActor();
            const updated = setActive(current, stepId, new Date().toISOString(), actor);
            const saved = await service.writeRoadmap(updated);
            return {
                response: ok({project, active: saved.active, summary: summarize(saved)}),
                event: {kind: 'write', touched: [`Memory/${project}/_roadmap.md`]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_roadmap_link_note',
            description: 'Link notes to a roadmap step. Titles, aliases or paths must resolve to existing notes (else nothing is linked); stored as canonical titles. Idempotent.',
            inputSchema: {
                type: 'object',
                properties: {
                    stepId: {type: 'string'},
                    notes: {type: 'array', items: {type: 'string'}, description: 'Titles, aliases or vault paths'}
                },
                required: ['stepId', 'notes']
            }
        },
        handle: async (args, ctx) => {
            const project = requireRoadmapProject(service, ctx);
            const stepId = asString(args.stepId, 'stepId');
            const notes = Array.isArray(args.notes)
                ? args.notes.filter((n): n is string => typeof n === 'string' && n.length > 0)
                : [];
            const current = service.readRoadmap(project);
            const existing = findStep(current.steps, stepId);
            if (existing === null) {
                throw new Error(`Step "${stepId}" not found in the ${project} roadmap.`);
            }
            const {resolved, unresolved} = resolveNoteLinks(service, notes);
            if (unresolved.length > 0) {
                throw new Error(
                    `These note references resolve to no existing note: ${unresolved.map((r) => `"${r}"`).join(', ')}. ` +
                        'Link a note by its exact title, an alias, or its vault path (e.g. Memory/<project>/note.md). ' +
                        'Nothing was linked.'
                );
            }
            const have = new Set(existing.noteLinks ?? []);
            const added = resolved.filter((n) => !have.has(n));
            const merged: RoadmapStep = {...existing, noteLinks: [...(existing.noteLinks ?? []), ...added]};
            const logged = added.length > 0
                ? appendActivity(merged, {at: new Date().toISOString(), who: roadmapActor(), what: `linked ${added.join(', ')}`})
                : merged;
            await service.writeRoadmap({...current, steps: upsertStep(current.steps, logged)});
            return {
                response: ok({project, stepId, added, skipped: resolved.filter((n) => have.has(n))}),
                event: {kind: 'write', touched: [`Memory/${project}/_roadmap.md`]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_roadmap_history',
            description: 'Past versions of the active project\'s roadmap (sha, message, author, date), newest first — input for roadmap_rollback.',
            inputSchema: {
                type: 'object',
                properties: {
                    limit: {type: 'number', description: 'Default 30'}
                }
            }
        },
        handle: async (args, ctx) => {
            const project = requireRoadmapProject(service, ctx);
            const limit = asLimit(args.limit, 30);
            const history = await service.roadmapHistory(project, limit);
            return {
                response: ok({project, history}),
                event: {kind: 'list', touched: []}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_roadmap_rollback',
            description: 'Restore the active project\'s roadmap to a past version (sha from roadmap_history), written as a new commit — itself reversible.',
            inputSchema: {
                type: 'object',
                properties: {
                    commitSha: {type: 'string', description: 'Full or short sha'}
                },
                required: ['commitSha']
            }
        },
        handle: async (args, ctx) => {
            const project = requireRoadmapProject(service, ctx);
            const commitSha = asString(args.commitSha, 'commitSha');
            const saved = await service.rollbackRoadmap(project, commitSha);
            return {
                response: ok({project, restoredFrom: commitSha, ...roadmapWriteResult(saved)}),
                event: {kind: 'write', touched: [`Memory/${project}/_roadmap.md`]}
            };
        }
    }
];
