import {describe, it, expect} from 'vitest';
import {
    type Roadmap,
    type RoadmapStep,
    ACTIVITY_CAP,
    appendActivity,
    applyDependencies,
    findStep,
    parseRoadmap,
    removeStep,
    renderRoadmapMarkdown,
    rollup,
    serializeRoadmap,
    setActive,
    summarize,
    upsertStep
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
