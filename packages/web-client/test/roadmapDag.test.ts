import type {RoadmapStep} from '@synaipse/core';
import {describe, expect, it} from 'vitest';
import {buildRoadmapDag, phaseIds} from '../src/RoadmapDag.js';

/** Plan P10 / S4: the roadmap as a dependency graph with collapsible phases. */

const step = (id: string, extra: Partial<RoadmapStep> = {}): RoadmapStep => ({id, title: `Step ${id}`, status: 'planned', ...extra});

// Phase 1 (1.1 → 1.2), phase 2 (2.1 depends on 1.2, 2.2 depends on 2.1), phase 3 depends on phase 2.
const tree: RoadmapStep[] = [
    step('1', {children: [step('1.1'), step('1.2', {dependsOn: ['1.1']})]}),
    step('2', {children: [step('2.1', {dependsOn: ['1.2']}), step('2.2', {dependsOn: ['2.1']})]}),
    step('3', {dependsOn: ['2']})
];

const edgeList = (dag: ReturnType<typeof buildRoadmapDag>): string[] =>
    dag.edges.map((e) => `${e.source}>${e.target}${e.count > 1 ? `x${e.count}` : ''}`).sort();
const columns = (dag: ReturnType<typeof buildRoadmapDag>): Record<string, number> =>
    Object.fromEntries(dag.nodes.map((n) => [n.id, n.column]));

describe('buildRoadmapDag', () => {
    it('all phases closed: one node per phase, step dependencies lifted onto them', () => {
        const dag = buildRoadmapDag(tree, new Set());
        expect(dag.nodes.map((n) => n.id)).toEqual(['1', '2', '3']);
        expect(dag.nodes.find((n) => n.id === '1')).toMatchObject({isPhase: true, hidden: 2});
        expect(edgeList(dag)).toEqual(['1>2', '2>3']);
        expect(columns(dag)).toEqual({1: 0, 2: 1, 3: 2});
        expect(dag.hulls).toEqual([]);
    });

    it('an open phase shows its steps in a hull; a dependency on it attaches to its exits', () => {
        const dag = buildRoadmapDag(tree, new Set(['2']));
        expect(dag.nodes.map((n) => n.id)).toEqual(['1', '2.1', '2.2', '3']);
        expect(dag.hulls).toEqual([{id: '2', title: 'Step 2', nodeIds: ['2.1', '2.2']}]);
        // 3 depends on phase 2 → on 2.2, the step nothing in phase 2 waits for.
        expect(edgeList(dag)).toEqual(['1>2.1', '2.1>2.2', '2.2>3']);
        expect(columns(dag)).toEqual({1: 0, 2.1: 1, 2.2: 2, 3: 3});
    });

    it('everything open: step level, parallel dependencies counted once per pair', () => {
        const dag = buildRoadmapDag(tree, new Set(['1', '2']));
        expect(edgeList(dag)).toEqual(['1.1>1.2', '1.2>2.1', '2.1>2.2', '2.2>3']);
        const merged = buildRoadmapDag([
            step('1', {children: [step('1.1'), step('1.2')]}),
            step('2', {dependsOn: ['1.1', '1.2']})
        ], new Set());
        expect(edgeList(merged)).toEqual(['1>2x2']);
    });

    it('drops dependencies inside a closed phase and unknown ids; survives cycles', () => {
        expect(buildRoadmapDag(tree, new Set()).edges.some((e) => e.source === e.target)).toBe(false);
        const odd = buildRoadmapDag([
            step('a', {dependsOn: ['b', 'missing']}),
            step('b', {dependsOn: ['a']}),
            step('c', {dependsOn: ['b']})
        ], new Set());
        expect(edgeList(odd)).toEqual(['a>b', 'b>a', 'b>c']);
        expect(odd.nodes).toHaveLength(3);
        for (const n of odd.nodes) expect(Number.isFinite(n.column)).toBe(true);
    });

    it('lists phases for open-all', () => {
        expect(phaseIds(tree)).toEqual(['1', '2']);
    });
});
