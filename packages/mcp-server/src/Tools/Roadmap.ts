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
import {asNumber, asString, ok, type ToolContext, type ToolHandler} from './Shared.js';

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
const patchStep = (step: RoadmapStep, args: Record<string, unknown>): RoadmapStep => {
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

/** Per-project roadmap planning (Memory/<project>/_roadmap.md). */
export const roadmapTools = (service: SynaipseService): ToolHandler[] => [
    {
        definition: {
            name: 'synaipse_roadmap_get',
            description: 'Read the active project\'s roadmap: the full step tree (arbitrarily nested), the live "AI is working here" cursor, and a rolled-up summary (progress %, planned vs actual hours, done/blocked counts). Pass stepId to return only that step and its subtree. Returns an empty roadmap if none exists yet. Read this before planning or updating so you build on the current state.',
            inputSchema: {
                type: 'object',
                properties: {
                    stepId: {type: 'string', description: 'Optional: return only this step and its children.'}
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
            description: 'Plan the roadmap for the active project. Two modes: (1) pass `steps` — an array of step objects — to REPLACE the whole tree (use for initial planning or restructuring); (2) pass a single `step` plus optional `parentId` to add or replace one step (append under a parent, or at root when parentId is omitted). Steps nest arbitrarily via each step\'s `children` array. Hours and progress roll up to parents automatically; open dependencies flip a step to "blocked". Writes Memory/<project>/_roadmap.md. SAFETY: the full-tree replace is non-destructive — per-step activity/audit logs are merged by id (an omitted activity list keeps existing history) and any step you leave out is kept as soft-deleted (hidden), never dropped. Prefer mode (2) for incremental edits.',
            inputSchema: {
                type: 'object',
                properties: {
                    steps: {
                        type: 'array',
                        description: 'Full step tree to replace the roadmap with. Each step: {id, title, status, plannedHours?, actualHours?, owner?("ai"|"human"), priority?("low"|"med"|"high"), noteLinks?, dependsOn?, acceptance?, evaluation?, children?}. Status one of: backlog, planned, in_progress, ai_active, review, blocked, done, cancelled. Use hierarchical ids like "1", "1.1", "2.3.1".',
                        items: {type: 'object'}
                    },
                    step: {type: 'object', description: 'Single step to upsert (alternative to steps).'},
                    parentId: {type: 'string', description: 'When upserting a single step, the parent step id to append under. Omit for a top-level step.'}
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
                response: ok(roadmapResult(saved)),
                event: {kind: 'write', touched: [noteId]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_roadmap_move',
            description: 'Move an existing roadmap step (with its whole subtree) to a new parent, or to the top level. This is the RE-PARENT / RE-ORDER tool: roadmap_plan replaces a step in place and never relocates it, so passing parentId there to an existing id does nothing. Pass stepId and newParentId (the id to nest it under; null/omit = top level). Optional position (0-based) places it among its new siblings; omit to append at the end. The step keeps its id — ids are labels, not positions, so "5.20" living under "5" is fine. Rejected: moving a step under itself or one of its own descendants (would detach the subtree). Non-destructive — nothing is dropped and it is versioned, so roadmap_rollback can undo it.',
            inputSchema: {
                type: 'object',
                properties: {
                    stepId: {type: 'string', description: 'Id of the step to move.'},
                    newParentId: {type: 'string', description: 'Id of the new parent to nest under. Omit or pass null/empty to move to the top level.'},
                    position: {type: 'number', description: '0-based index among the new siblings. Omit to append at the end.'}
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
                response: ok(roadmapResult(saved)),
                event: {kind: 'write', touched: [`Memory/${project}/_roadmap.md`]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_roadmap_update_step',
            description: 'Patch a single roadmap step by id: change status, book time (actualHours), adjust the estimate (plannedHours), set progress (0-100), owner, priority, acceptance criteria, or write your evaluation/rationale. Only the fields you pass change. Appends an activity-log entry to the step. Use this as you work — e.g. mark a step "review" and record what you did in `evaluation`.',
            inputSchema: {
                type: 'object',
                properties: {
                    stepId: {type: 'string', description: 'Id of the step to update.'},
                    status: {type: 'string', description: 'New status: backlog|planned|in_progress|ai_active|review|blocked|done|cancelled'},
                    title: {type: 'string'},
                    plannedHours: {type: 'number', description: 'Planned implementation time in hours.'},
                    actualHours: {type: 'number', description: 'Actual time spent in hours.'},
                    progress: {type: 'number', description: '0-100.'},
                    owner: {type: 'string', description: '"ai" or "human".'},
                    priority: {type: 'string', description: '"low", "med" or "high".'},
                    acceptance: {type: 'string', description: 'Definition of done.'},
                    evaluation: {type: 'string', description: 'Your assessment / rationale / remaining-estimate for this step.'},
                    dependsOn: {type: 'array', items: {type: 'string'}, description: 'Step ids this step depends on.'},
                    deleted: {type: 'boolean', description: 'Soft-delete (true) or restore (false) this step. Deleting cascades to sub-steps and hides them from KPIs/table/body, but the step is kept in the vault and stays reversible — steps are never hard-deleted.'},
                    note: {type: 'string', description: 'Optional activity-log message (defaults to a summary of changed fields).'}
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
                response: ok({project, step: findStep(saved.steps, stepId), summary: summarize(saved)}),
                event: {kind: 'write', touched: [`Memory/${project}/_roadmap.md`]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_roadmap_set_active',
            description: 'Set the live "AI is working here" cursor to a step: it becomes status "ai_active" and any previously-active step drops back to "in_progress". Pass stepId=null (or omit) to clear the cursor. At most one step is active at a time. Call this when you start working on a step so the UI shows a live indicator; call update_step to record progress and clear when you move on.',
            inputSchema: {
                type: 'object',
                properties: {
                    stepId: {type: 'string', description: 'Step to mark active. Omit or pass empty to clear the cursor.'}
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
            description: 'Attach note links to a roadmap step. Pass note titles, aliases, vault paths or ids — each is resolved against the vault to an EXISTING note and stored in its canonical wikilink form, so backlinks and graph edges work. References that match no note are REJECTED (the whole call fails, naming the offenders) so a step never accumulates dead links. Idempotent: already-linked notes are skipped.',
            inputSchema: {
                type: 'object',
                properties: {
                    stepId: {type: 'string', description: 'Step to link notes to.'},
                    notes: {type: 'array', items: {type: 'string'}, description: 'Note titles, aliases, paths or ids to link. Must resolve to existing notes; unresolvable refs are rejected.'}
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
            description: 'List past versions (ngit commits) of the active project\'s roadmap, newest first. Each entry has a sha, commit message, author and date. Use this to find a good version to restore with synaipse_roadmap_rollback when an edit went wrong. Empty when history is disabled or the roadmap was never written.',
            inputSchema: {
                type: 'object',
                properties: {
                    limit: {type: 'number', description: 'Max commits to return (default 30).'}
                }
            }
        },
        handle: async (args, ctx) => {
            const project = requireRoadmapProject(service, ctx);
            const limit = asNumber(args.limit, 30);
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
            description: 'Restore the active project\'s roadmap to a past version by commit sha (from synaipse_roadmap_history). Reads the roadmap as it stood at that commit and writes it forward as a NEW commit — nothing is lost and the rollback is itself reversible (roll forward again to any later sha). Use this as the escape hatch when a plan/replace or move went wrong. Throws if history is disabled or the sha has no valid roadmap.',
            inputSchema: {
                type: 'object',
                properties: {
                    commitSha: {type: 'string', description: 'The commit sha to restore (full or the abbreviated sha from roadmap_history).'}
                },
                required: ['commitSha']
            }
        },
        handle: async (args, ctx) => {
            const project = requireRoadmapProject(service, ctx);
            const commitSha = asString(args.commitSha, 'commitSha');
            const saved = await service.rollbackRoadmap(project, commitSha);
            return {
                response: ok({project, restoredFrom: commitSha, ...(roadmapResult(saved) as object)}),
                event: {kind: 'write', touched: [`Memory/${project}/_roadmap.md`]}
            };
        }
    }
];
