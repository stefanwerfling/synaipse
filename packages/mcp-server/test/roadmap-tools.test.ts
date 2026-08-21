import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SynaipseService} from '@synaipse/service';
import {buildTools, EMPTY_CTX, type ToolHandler} from '../src/Tools.js';

const buildConfig = (vaultPath: string, indexCachePath: string) => ({
    vaultPath,
    indexCachePath,
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    auditLogPath: path.join(vaultPath, '.audit.jsonl'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://localhost:6333', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0},
    project: {name: 'proj'}
});

let vaultDir: string;
let service: SynaipseService;
let tools: Map<string, ToolHandler>;

const parse = (outcome: {response: {content: Array<{text: string}>}}): any =>
    JSON.parse(outcome.response.content[0]!.text);

const call = (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`${name} not registered`);
    return tool.handle(args, EMPTY_CTX);
};

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-rm-tool-'));
    service = new SynaipseService(buildConfig(vaultDir, path.join(vaultDir, '.cache.json')));
    await service.start();
    tools = new Map(buildTools(service).map((t) => [t.definition.name, t]));
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('roadmap tools registration + ACL', () => {
    it('registers all roadmap tools with correct modes', () => {
        expect(tools.get('synaipse_roadmap_get')?.mode).toBe('read');
        expect(tools.get('synaipse_roadmap_history')?.mode).toBe('read');
        expect(tools.get('synaipse_roadmap_plan')?.mode).toBe('write');
        expect(tools.get('synaipse_roadmap_update_step')?.mode).toBe('write');
        expect(tools.get('synaipse_roadmap_move')?.mode).toBe('write');
        expect(tools.get('synaipse_roadmap_set_active')?.mode).toBe('write');
        expect(tools.get('synaipse_roadmap_link_note')?.mode).toBe('write');
        expect(tools.get('synaipse_roadmap_rollback')?.mode).toBe('write');
    });
});

describe('synaipse_roadmap_move', () => {
    it('reparents a top-level step (with subtree) under another step', async () => {
        // Reproduces the "created without parentId → stuck at root" case.
        await call('synaipse_roadmap_plan', {steps: [
            {id: '5', title: 'Bragi', status: 'in_progress', children: [{id: '5.1', title: 'a', status: 'done'}]},
            {id: '9', title: 'Phase 9', status: 'planned'}
        ]});
        await call('synaipse_roadmap_plan', {step: {
            id: '5.20', title: 'Qwen loader', status: 'in_progress',
            children: [{id: '5.20.1', title: 'parser', status: 'in_progress'}]
        }}); // no parentId → lands at root, after 9

        let got = parse(await call('synaipse_roadmap_get', {}));
        expect(got.steps.map((s: any) => s.id)).toEqual(['5', '9', '5.20']);

        const payload = parse(await call('synaipse_roadmap_move', {stepId: '5.20', newParentId: '5'}));
        expect(payload.steps.map((s: any) => s.id)).toEqual(['5', '9']);

        got = parse(await call('synaipse_roadmap_get', {}));
        const five = got.steps.find((s: any) => s.id === '5');
        expect(five.children.map((c: any) => c.id)).toEqual(['5.1', '5.20']);
        expect(five.children.find((c: any) => c.id === '5.20').children[0].id).toBe('5.20.1');
        // move was logged on the step's activity
        expect(five.children.find((c: any) => c.id === '5.20').activity.some((e: any) => /moved/.test(e.what))).toBe(true);
    });

    it('rejects cycles and unknown ids', async () => {
        await call('synaipse_roadmap_plan', {steps: [
            {id: '1', title: 'A', status: 'planned', children: [{id: '1.1', title: 'B', status: 'planned'}]}
        ]});
        await expect(call('synaipse_roadmap_move', {stepId: '1', newParentId: '1.1'})).rejects.toThrow(/descendant/);
        await expect(call('synaipse_roadmap_move', {stepId: 'nope', newParentId: '1'})).rejects.toThrow(/not found/);
    });
});

describe('synaipse_roadmap_history + rollback', () => {
    it('lists versions and rolls back to a past one', async () => {
        // v1: one step. v2: two steps.
        await call('synaipse_roadmap_plan', {steps: [{id: '1', title: 'One', status: 'planned'}]});
        await call('synaipse_roadmap_plan', {steps: [
            {id: '1', title: 'One', status: 'planned'},
            {id: '2', title: 'Two', status: 'planned'}
        ]});

        const hist = parse(await call('synaipse_roadmap_history', {})).history;
        expect(hist.length).toBeGreaterThanOrEqual(2);
        // newest-first: hist[0] is v2, the last entry is v1.
        const v1 = hist[hist.length - 1];
        expect(v1.sha).toMatch(/^[0-9a-f]{7,}$/);

        const rolled = parse(await call('synaipse_roadmap_rollback', {commitSha: v1.sha}));
        expect(rolled.restoredFrom).toBe(v1.sha);
        expect(rolled.steps.map((s: any) => s.id)).toEqual(['1']); // step 2 is gone in v1

        const got = parse(await call('synaipse_roadmap_get', {}));
        expect(got.steps.map((s: any) => s.id)).toEqual(['1']);
    });
});

describe('synaipse_roadmap_plan', () => {
    it('plans a full step tree and persists the note', async () => {
        const outcome = await call('synaipse_roadmap_plan', {
            steps: [
                {
                    id: '1',
                    title: 'Phase 1',
                    status: 'in_progress',
                    children: [
                        {id: '1.1', title: 'Sub A', status: 'done', plannedHours: 2, actualHours: 2},
                        {id: '1.2', title: 'Sub B', status: 'planned', plannedHours: 4}
                    ]
                }
            ]
        });
        const payload = parse(outcome);
        expect(payload.steps[0].plannedHours).toBe(6); // rolled up
        expect(payload.summary.totalSteps).toBe(3);
        expect(outcome.event?.touched).toContain('Memory/proj/_roadmap.md');

        const onDisk = await readFile(path.join(vaultDir, 'Memory/proj/_roadmap.md'), 'utf8');
        expect(onDisk).toContain('# Roadmap: proj');
        expect(onDisk).toContain('Sub A');
    });

    it('upserts a single step under a parent', async () => {
        await call('synaipse_roadmap_plan', {steps: [{id: '1', title: 'P1', status: 'planned'}]});
        await call('synaipse_roadmap_plan', {step: {id: '1.1', title: 'Child', status: 'planned'}, parentId: '1'});
        const got = parse(await call('synaipse_roadmap_get', {}));
        expect(got.steps[0].children[0].id).toBe('1.1');
    });

    it('full-tree replace preserves activity logs and soft-deletes omitted steps', async () => {
        // Seed two steps, record activity on step 1 via update_step.
        await call('synaipse_roadmap_plan', {
            steps: [
                {id: '1', title: 'Keep', status: 'planned'},
                {id: '2', title: 'Vanishes', status: 'planned'}
            ]
        });
        await call('synaipse_roadmap_update_step', {stepId: '1', status: 'in_progress', note: 'kicked off'});

        // A "stale" full replace that omits step 1's activity AND drops step 2.
        await call('synaipse_roadmap_plan', {steps: [{id: '1', title: 'Keep', status: 'in_progress'}]});

        const got = parse(await call('synaipse_roadmap_get', {}));
        const one = got.steps.find((s: any) => s.id === '1');
        const two = got.steps.find((s: any) => s.id === '2');
        // Activity survived the replace.
        expect(one.activity.some((e: any) => e.what === 'kicked off')).toBe(true);
        // Omitted step is kept, just soft-deleted.
        expect(two).toBeDefined();
        expect(two.deleted).toBe(true);
        // KPIs ignore the soft-deleted step.
        expect(got.summary.totalSteps).toBe(1);
    });
});

describe('synaipse_roadmap_update_step', () => {
    it('patches fields and logs activity', async () => {
        await call('synaipse_roadmap_plan', {steps: [{id: '1', title: 'A', status: 'planned'}]});
        const outcome = await call('synaipse_roadmap_update_step', {
            stepId: '1',
            status: 'review',
            actualHours: 3,
            evaluation: 'done pending review'
        });
        const payload = parse(outcome);
        expect(payload.step.status).toBe('review');
        expect(payload.step.actualHours).toBe(3);
        expect(payload.step.evaluation).toBe('done pending review');
        expect(payload.step.activity.length).toBeGreaterThan(0);
    });

    it('errors on unknown step', async () => {
        await call('synaipse_roadmap_plan', {steps: [{id: '1', title: 'A', status: 'planned'}]});
        await expect(call('synaipse_roadmap_update_step', {stepId: 'nope', status: 'done'})).rejects.toThrow();
    });

    it('soft-deletes (cascading) and restores via the deleted flag', async () => {
        await call('synaipse_roadmap_plan', {
            steps: [{id: '1', title: 'A', status: 'planned', children: [{id: '1.1', title: 'A1', status: 'planned'}]}]
        });

        await call('synaipse_roadmap_update_step', {stepId: '1', deleted: true});
        let got = parse(await call('synaipse_roadmap_get', {}));
        expect(got.steps[0].deleted).toBe(true);
        expect(got.steps[0].children[0].deleted).toBe(true); // cascaded
        expect(got.summary.totalSteps).toBe(0); // excluded from KPIs

        await call('synaipse_roadmap_update_step', {stepId: '1', deleted: false});
        got = parse(await call('synaipse_roadmap_get', {}));
        expect(got.steps[0].deleted).toBeUndefined();
        expect(got.steps[0].children[0].deleted).toBeUndefined();
        expect(got.summary.totalSteps).toBe(2);
    });
});

describe('synaipse_roadmap_set_active', () => {
    it('marks one step ai_active and clears with empty stepId', async () => {
        await call('synaipse_roadmap_plan', {
            steps: [
                {id: '1', title: 'A', status: 'in_progress'},
                {id: '2', title: 'B', status: 'planned'}
            ]
        });

        let payload = parse(await call('synaipse_roadmap_set_active', {stepId: '2'}));
        expect(payload.active.stepId).toBe('2');
        let got = parse(await call('synaipse_roadmap_get', {}));
        expect(got.steps.find((s: any) => s.id === '2').status).toBe('ai_active');

        payload = parse(await call('synaipse_roadmap_set_active', {}));
        expect(payload.active).toBeNull();
        got = parse(await call('synaipse_roadmap_get', {}));
        expect(got.steps.find((s: any) => s.id === '2').status).toBe('in_progress');
    });
});

describe('synaipse_roadmap_link_note', () => {
    it('links notes idempotently', async () => {
        await call('synaipse_roadmap_plan', {steps: [{id: '1', title: 'A', status: 'planned'}]});
        let payload = parse(await call('synaipse_roadmap_link_note', {stepId: '1', notes: ['ADR-x', 'ADR-y']}));
        expect(payload.added).toEqual(['ADR-x', 'ADR-y']);
        payload = parse(await call('synaipse_roadmap_link_note', {stepId: '1', notes: ['ADR-x', 'ADR-z']}));
        expect(payload.added).toEqual(['ADR-z']);
        expect(payload.skipped).toEqual(['ADR-x']);
    });
});

describe('project scoping', () => {
    it('requires a project context', async () => {
        // Build a service without a project and confirm the tool refuses.
        const noProjVault = await mkdtemp(path.join(tmpdir(), 'synaipse-rm-noproj-'));
        const svc = new SynaipseService({
            ...buildConfig(noProjVault, path.join(noProjVault, '.cache.json')),
            project: undefined as never
        });
        await svc.start();
        const tool = buildTools(svc).find((t) => t.definition.name === 'synaipse_roadmap_get');
        await expect(tool!.handle({}, EMPTY_CTX)).rejects.toThrow(/project/i);
        await svc.stop();
        await rm(noProjVault, {recursive: true, force: true});
    });
});
