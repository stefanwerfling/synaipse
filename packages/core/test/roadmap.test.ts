import {describe, it, expect} from 'vitest';
import {
    type Roadmap,
    type RoadmapStep,
    ACTIVITY_CAP,
    appendActivity,
    applyDependencies,
    findStep,
    hasDeleted,
    parseRoadmap,
    reconcilePlan,
    removeStep,
    renderRoadmapMarkdown,
    rollup,
    serializeRoadmap,
    setActive,
    setStepDeleted,
    summarize,
    upsertStep,
    withoutDeleted
} from '../src/Index.js';

const step = (id: string, over: Partial<RoadmapStep> = {}): RoadmapStep => ({
    id,
    title: `Step ${id}`,
    status: 'planned',
    ...over
});

const roadmap = (steps: RoadmapStep[], over: Partial<Roadmap> = {}): Roadmap => ({
    project: 'synaipse',
    updatedAt: '2026-08-16T10:00:00.000Z',
    active: null,
    steps,
    ...over
});

describe('findStep', () => {
    it('finds nested steps', () => {
        const rm = roadmap([step('1', {children: [step('1.1'), step('1.2')]})]);
        expect(findStep(rm.steps, '1.2')?.title).toBe('Step 1.2');
        expect(findStep(rm.steps, 'nope')).toBeNull();
    });
});

describe('upsertStep', () => {
    it('appends at root when no parent', () => {
        const next = upsertStep([step('1')], step('2'));
        expect(next.map((s) => s.id)).toEqual(['1', '2']);
    });

    it('appends under a parent', () => {
        const next = upsertStep([step('1')], step('1.1'), '1');
        expect(next[0].children?.[0].id).toBe('1.1');
    });

    it('replaces in place and preserves children when incoming has none', () => {
        const start = [step('1', {children: [step('1.1')]})];
        const next = upsertStep(start, {id: '1', title: 'Renamed', status: 'done'});
        expect(next[0].title).toBe('Renamed');
        expect(next[0].status).toBe('done');
        expect(next[0].children?.[0].id).toBe('1.1');
    });

    it('does not mutate the input', () => {
        const start = [step('1')];
        upsertStep(start, step('2'));
        expect(start).toHaveLength(1);
    });
});

describe('removeStep', () => {
    it('removes a subtree', () => {
        const start = [step('1', {children: [step('1.1'), step('1.2')]})];
        const next = removeStep(start, '1.1');
        expect(next[0].children?.map((s) => s.id)).toEqual(['1.2']);
    });
});

describe('rollup', () => {
    it('sums leaf hours and averages progress into parents', () => {
        const rolled = rollup([
            step('1', {
                children: [
                    step('1.1', {plannedHours: 2, actualHours: 1, status: 'done'}),
                    step('1.2', {plannedHours: 4, actualHours: 3, progress: 50})
                ]
            })
        ]);
        expect(rolled[0].plannedHours).toBe(6);
        expect(rolled[0].actualHours).toBe(4);
        // done leaf => 100, other => 50, avg => 75
        expect(rolled[0].progress).toBe(75);
    });

    it('defaults leaf progress to 100 when done, else its own value', () => {
        const rolled = rollup([step('1', {status: 'done'}), step('2', {progress: 30})]);
        expect(rolled[0].progress).toBe(100);
        expect(rolled[1].progress).toBe(30);
    });
});

describe('setActive', () => {
    it('marks exactly one step ai_active and moves the old cursor to in_progress', () => {
        const rm = roadmap([step('1', {status: 'ai_active'}), step('2')]);
        const next = setActive(rm, '2', '2026-08-16T11:00:00.000Z', 'claude');
        expect(findStep(next.steps, '1')?.status).toBe('in_progress');
        expect(findStep(next.steps, '2')?.status).toBe('ai_active');
        expect(next.active).toEqual({stepId: '2', since: '2026-08-16T11:00:00.000Z', token: 'claude'});
    });

    it('clears the cursor with null', () => {
        const rm = roadmap([step('1', {status: 'ai_active'})], {active: {stepId: '1', since: 'x'}});
        const next = setActive(rm, null, 'now');
        expect(next.active).toBeNull();
        expect(findStep(next.steps, '1')?.status).toBe('in_progress');
    });
});

describe('applyDependencies', () => {
    it('blocks a step whose dependency is still open', () => {
        const rm = roadmap([step('1', {status: 'in_progress'}), step('2', {dependsOn: ['1']})]);
        const next = applyDependencies(rm);
        expect(findStep(next.steps, '2')?.status).toBe('blocked');
    });

    it('lifts a blocked step once its dependency is done', () => {
        const rm = roadmap([step('1', {status: 'done'}), step('2', {status: 'blocked', dependsOn: ['1']})]);
        const next = applyDependencies(rm);
        expect(findStep(next.steps, '2')?.status).toBe('planned');
    });

    it('never un-blocks a done step', () => {
        const rm = roadmap([step('1', {status: 'in_progress'}), step('2', {status: 'done', dependsOn: ['1']})]);
        const next = applyDependencies(rm);
        expect(findStep(next.steps, '2')?.status).toBe('done');
    });
});

describe('appendActivity', () => {
    it('caps the log', () => {
        let s = step('1');
        for (let i = 0; i < ACTIVITY_CAP + 5; i++) {
            s = appendActivity(s, {at: `t${i}`, who: 'claude', what: `event ${i}`});
        }
        expect(s.activity).toHaveLength(ACTIVITY_CAP);
        expect(s.activity?.[s.activity.length - 1].what).toBe(`event ${ACTIVITY_CAP + 4}`);
    });
});

describe('summarize', () => {
    it('aggregates counts and progress', () => {
        const rm = roadmap([
            step('1', {status: 'done', plannedHours: 2, actualHours: 2}),
            step('2', {status: 'blocked', plannedHours: 4}),
            step('3', {status: 'in_progress', plannedHours: 2, progress: 50})
        ]);
        const s = summarize(rm);
        expect(s.totalSteps).toBe(3);
        expect(s.doneSteps).toBe(1);
        expect(s.blockedSteps).toBe(1);
        expect(s.plannedHours).toBe(8);
        expect(s.actualHours).toBe(2);
        // 100 + 0 + 50 => 50
        expect(s.progress).toBe(50);
    });
});

describe('parse / serialize round-trip', () => {
    it('round-trips a nested roadmap', () => {
        const rm = roadmap([
            step('1', {
                status: 'done',
                owner: 'ai',
                plannedHours: 2,
                noteLinks: ['ADR-roadmap'],
                children: [step('1.1', {status: 'done', actualHours: 1})]
            })
        ], {active: {stepId: '1.1', since: 'now', token: 'claude'}});

        const fm = {roadmap: serializeRoadmap(rm)};
        const parsed = parseRoadmap('synaipse', fm);
        expect(parsed).not.toBeNull();
        expect(parsed?.steps[0].children?.[0].id).toBe('1.1');
        expect(parsed?.steps[0].owner).toBe('ai');
        expect(parsed?.active?.stepId).toBe('1.1');
    });

    it('returns null when there is no roadmap payload', () => {
        expect(parseRoadmap('x', {})).toBeNull();
        expect(parseRoadmap('x', {roadmap: 'nope'})).toBeNull();
    });

    it('silently skips malformed steps', () => {
        const parsed = parseRoadmap('x', {
            roadmap: {
                steps: [
                    {id: '1', title: 'ok', status: 'planned'},
                    {id: '2'}, // no title → dropped
                    {title: 'no id'}, // no id → dropped
                    null,
                    'garbage'
                ]
            }
        });
        expect(parsed?.steps.map((s) => s.id)).toEqual(['1']);
    });

    it('defaults unknown status to planned', () => {
        const parsed = parseRoadmap('x', {roadmap: {steps: [{id: '1', title: 't', status: 'wat'}]}});
        expect(parsed?.steps[0].status).toBe('planned');
    });
});

describe('renderRoadmapMarkdown', () => {
    it('renders a table, KPI line and mermaid, with the autogen marker', () => {
        const rm = roadmap([
            step('1', {
                status: 'ai_active',
                children: [step('1.1', {status: 'done', plannedHours: 2, actualHours: 2})]
            })
        ], {active: {stepId: '1', since: 'now'}});
        const md = renderRoadmapMarkdown(rm);
        expect(md).toContain('Auto-generiert');
        expect(md).toContain('# Roadmap: synaipse');
        expect(md).toContain('KI arbeitet gerade an:');
        expect(md).toContain('| # | Schritt | Status |');
        expect(md).toContain('```mermaid');
    });
});

describe('setStepDeleted (soft-delete)', () => {
    it('marks a step and its whole subtree deleted, cascading', () => {
        const rm = roadmap([step('1', {children: [step('1.1'), step('1.2', {children: [step('1.2.1')]})]})]);
        const next = setStepDeleted(rm.steps, '1', true);
        const ids: string[] = [];
        const walk = (s: RoadmapStep[]): void => s.forEach((x) => {
            expect(x.deleted).toBe(true);
            ids.push(x.id);
            if (x.children) walk(x.children);
        });
        walk(next);
        expect(ids).toEqual(['1', '1.1', '1.2', '1.2.1']);
    });

    it('restores cascading and never removes the node', () => {
        const deleted = setStepDeleted([step('1', {children: [step('1.1')]})], '1', true);
        const restored = setStepDeleted(deleted, '1', false);
        expect(hasDeleted(restored)).toBe(false);
        expect(findStep(restored, '1.1')?.deleted).toBeUndefined();
    });

    it('is a no-op for a missing id', () => {
        const rm = [step('1')];
        expect(setStepDeleted(rm, 'nope', true)).toEqual(rm);
    });

    it('round-trips deleted through parse/serialize', () => {
        const rm = roadmap([step('1', {deleted: true})]);
        const parsed = parseRoadmap('synaipse', {roadmap: serializeRoadmap(rm)});
        expect(parsed?.steps[0]?.deleted).toBe(true);
    });
});

describe('deleted steps are excluded from aggregates + body', () => {
    it('withoutDeleted prunes deleted subtrees but keeps the rest', () => {
        const rm = [step('1', {deleted: true}), step('2', {children: [step('2.1'), step('2.2', {deleted: true})]})];
        const pruned = withoutDeleted(rm);
        expect(pruned.map((s) => s.id)).toEqual(['2']);
        expect(pruned[0]?.children?.map((s) => s.id)).toEqual(['2.1']);
    });

    it('summarize ignores deleted steps', () => {
        const rm = roadmap([
            step('1', {status: 'done'}),
            step('2', {status: 'done', deleted: true})
        ]);
        const s = summarize(rm);
        expect(s.totalSteps).toBe(1);
        expect(s.doneSteps).toBe(1);
    });

    it('rollup does not count deleted leaves into a parent', () => {
        const rm = [step('1', {children: [
            step('1.1', {plannedHours: 4, actualHours: 3, progress: 100}),
            step('1.2', {plannedHours: 10, actualHours: 10, deleted: true})
        ]})];
        const rolled = rollup(rm);
        expect(rolled[0]?.plannedHours).toBe(4);
        expect(rolled[0]?.actualHours).toBe(3);
        // deleted leaf stays present in the tree
        expect(rolled[0]?.children?.some((c) => c.id === '1.2')).toBe(true);
    });

    it('renderRoadmapMarkdown hides deleted rows but notes the count', () => {
        const rm = roadmap([step('1'), step('2', {deleted: true, title: 'Weg damit'})]);
        const md = renderRoadmapMarkdown(rm);
        expect(md).not.toContain('Weg damit');
        expect(md).toContain('1 gelöscht (ausgeblendet)');
    });
});

describe('reconcilePlan (non-destructive full-tree replace)', () => {
    const ev = (at: string, what: string) => ({at, who: 'claude', what});

    it('merges per-step activity by id when the incoming step omits it', () => {
        const current = [step('1', {activity: [ev('2026-08-01T00:00:00.000Z', 'started')]})];
        const incoming = [step('1', {title: 'Renamed'})]; // no activity
        const merged = reconcilePlan(current, incoming);
        expect(merged[0]?.title).toBe('Renamed');
        expect(merged[0]?.activity?.map((e) => e.what)).toEqual(['started']);
    });

    it('unions and dedupes activity from both sides', () => {
        const current = [step('1', {activity: [ev('2026-08-01T00:00:00.000Z', 'a'), ev('2026-08-02T00:00:00.000Z', 'b')]})];
        const incoming = [step('1', {activity: [ev('2026-08-02T00:00:00.000Z', 'b'), ev('2026-08-03T00:00:00.000Z', 'c')]})];
        const merged = reconcilePlan(current, incoming);
        expect(merged[0]?.activity?.map((e) => e.what)).toEqual(['a', 'b', 'c']);
    });

    it('soft-deletes steps missing from the incoming tree instead of dropping them', () => {
        const current = [step('1'), step('2', {children: [step('2.1')]})];
        const incoming = [step('1')]; // 2 + 2.1 vanished
        const merged = reconcilePlan(current, incoming);
        expect(findStep(merged, '2')?.deleted).toBe(true);
        expect(findStep(merged, '2.1')?.deleted).toBe(true);
        // and summary ignores them
        expect(summarize(roadmap(merged)).totalSteps).toBe(1);
    });

    it('carries a vanished child back under its surviving parent', () => {
        const current = [step('1', {children: [step('1.1'), step('1.2')]})];
        const incoming = [step('1', {children: [step('1.1')]})]; // 1.2 vanished, parent survives
        const merged = reconcilePlan(current, incoming);
        const parent = findStep(merged, '1');
        expect(parent?.children?.map((c) => c.id).sort()).toEqual(['1.1', '1.2']);
        expect(findStep(merged, '1.2')?.deleted).toBe(true);
        expect(findStep(merged, '1.1')?.deleted).toBeUndefined();
    });
});
