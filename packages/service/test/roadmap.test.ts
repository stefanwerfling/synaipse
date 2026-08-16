import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Roadmap} from '@synaipse/core';
import {SynaipseService} from '../src/Service.js';
import {roadmapPathFor, projectFromRoadmapPath} from '../src/Roadmap.js';

const buildConfig = (vaultPath: string, indexCachePath: string) => ({
    vaultPath,
    indexCachePath,
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    auditLogPath: path.join(vaultPath, '.audit.jsonl'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://localhost:6333', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0}
});

let vaultDir: string;
let cacheFile: string;
let service: SynaipseService;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-rm-'));
    cacheFile = path.join(vaultDir, '.cache.json');
    service = new SynaipseService(buildConfig(vaultDir, cacheFile));
    await service.start();
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

const roadmap = (steps: Roadmap['steps']): Roadmap => ({
    project: 'demo',
    updatedAt: '',
    active: null,
    steps
});

describe('roadmapPathFor / projectFromRoadmapPath', () => {
    it('builds and reverses the note path', () => {
        expect(roadmapPathFor('demo')).toBe('Memory/demo/_roadmap.md');
        expect(projectFromRoadmapPath('Memory/demo/_roadmap.md')).toBe('demo');
        expect(projectFromRoadmapPath('Memory/demo/other.md')).toBeNull();
    });

    it('rejects invalid project names', () => {
        expect(() => roadmapPathFor('../etc')).toThrow();
    });
});

describe('SynaipseService roadmap round-trip', () => {
    it('returns an empty roadmap before any write', () => {
        const rm = service.readRoadmap('demo');
        expect(rm.steps).toEqual([]);
        expect(rm.active).toBeNull();
    });

    it('writes and reads back a nested roadmap, rolling up parent hours', async () => {
        await service.writeRoadmap(
            roadmap([
                {
                    id: '1',
                    title: 'Phase 1',
                    status: 'in_progress',
                    children: [
                        {id: '1.1', title: 'Sub A', status: 'done', plannedHours: 2, actualHours: 2},
                        {id: '1.2', title: 'Sub B', status: 'planned', plannedHours: 4}
                    ]
                }
            ])
        );

        const read = service.readRoadmap('demo');
        expect(read.steps[0].id).toBe('1');
        expect(read.steps[0].children?.map((s) => s.id)).toEqual(['1.1', '1.2']);
        // roll-up persisted on the parent
        expect(read.steps[0].plannedHours).toBe(6);
        expect(read.steps[0].actualHours).toBe(2);
    });

    it('gates a step on an open dependency and persists blocked status', async () => {
        await service.writeRoadmap(
            roadmap([
                {id: '1', title: 'A', status: 'in_progress'},
                {id: '2', title: 'B', status: 'planned', dependsOn: ['1']}
            ])
        );
        const read = service.readRoadmap('demo');
        expect(read.steps.find((s) => s.id === '2')?.status).toBe('blocked');
    });

    it('surfaces the roadmap in the list view with a summary', async () => {
        await service.writeRoadmap(
            roadmap([{id: '1', title: 'A', status: 'done', plannedHours: 3, actualHours: 3}])
        );
        const list = service.listRoadmaps();
        const demo = list.find((s) => s.project === 'demo');
        expect(demo).toBeDefined();
        expect(demo?.totalSteps).toBe(1);
        expect(demo?.doneSteps).toBe(1);
        expect(demo?.progress).toBe(100);
    });

    it('renders a human-readable body into the note', () => {
        // written above in another test scope? write fresh here
        return service
            .writeRoadmap(roadmap([{id: '1', title: 'Visible Step', status: 'planned'}]))
            .then(() => {
                const note = service.readNote('Memory/demo/_roadmap.md');
                expect(note.content).toContain('# Roadmap: demo');
                expect(note.content).toContain('Visible Step');
                expect(note.frontmatter.roadmap).toBeDefined();
                expect(note.tags).toContain('roadmap');
            });
    });
});
