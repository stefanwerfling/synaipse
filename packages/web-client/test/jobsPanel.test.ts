import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import type {JobRecord, JobUpdate, Schedule} from '../src/Api.js';
import type {EventStream} from '../src/Events.js';

/**
 * The Jobs panel follows job progress through `job` events on the page's
 * one event stream (no stream of its own per job). linkedom stands in for
 * the DOM; the API is a fake.
 */

const api = vi.hoisted(() => ({
    schedules: [] as Schedule[],
    jobs: [] as JobRecord[],
    listCalls: 0
}));

vi.mock('../src/Api.js', () => ({
    schedulesApi: {list: async () => api.schedules.map((s) => ({...s}))},
    jobsApi: {
        list: async () => {
            api.listCalls++;
            return api.jobs.map((j) => ({...j, progress: {...j.progress}}));
        }
    }
}));

/** The part of EventStream the panel uses, driven by the test. */
class FakeStream {
    public readonly named = new Map<string, Set<(data: unknown) => void>>();
    public readonly reconnect = new Set<() => void>();

    public subscribeNamed(name: string, fn: (data: unknown) => void): () => void {
        const set = this.named.get(name) ?? new Set();
        this.named.set(name, set);
        set.add(fn);
        return () => set.delete(fn);
    }

    public onReconnect(fn: () => void): () => void {
        this.reconnect.add(fn);
        return () => this.reconnect.delete(fn);
    }

    public job(update: JobUpdate): void {
        for (const fn of this.named.get('job') ?? []) fn(update);
    }

    public listeners(): number {
        return (this.named.get('job')?.size ?? 0) + this.reconnect.size;
    }
}

const schedule = (id: string): Schedule => ({
    id, name: `Schedule ${id}`, jobType: 'relink', jobParams: JSON.stringify({prefix: ''}),
    cron: '', enabled: true, createdAt: 0
});

const job = (id: string, over: Partial<JobRecord> = {}): JobRecord => ({
    id, type: 'relink', params: {prefix: ''}, status: 'running', scheduleId: 's1',
    progress: {done: 0, total: 10, failed: 0}, startedAt: 0, logs: [], ...over
});

const update = (j: JobRecord): JobUpdate => ({
    id: j.id, type: j.type, status: j.status, progress: j.progress,
    ...(j.scheduleId !== undefined ? {scheduleId: j.scheduleId} : {}),
    ...(j.summary !== undefined ? {summary: j.summary} : {}),
    ...(j.error !== undefined ? {error: j.error} : {})
});

let JobsPanel: typeof import('../src/JobsPanel.js').JobsPanel;

beforeAll(async () => {
    const {window} = parseHTML('<!doctype html><html><body></body></html>');
    for (const key of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'Event', 'CustomEvent'] as const) {
        Object.defineProperty(globalThis, key, {value: key === 'window' ? window : window[key], configurable: true, writable: true});
    }
    ({JobsPanel} = await import('../src/JobsPanel.js'));
});

let stream: FakeStream;
let panel: InstanceType<typeof JobsPanel>;

const shown = async (): Promise<void> => {
    panel = new JobsPanel({events: stream as unknown as EventStream});
    await panel.onShow();
};
const row = (): {label: string; current: string; width: string; hidden: boolean} => {
    const wrap = panel.element.querySelector('.job-progress-label')!.parentElement!;
    return {
        label: panel.element.querySelector('.job-progress-label')!.textContent ?? '',
        current: panel.element.querySelector('.job-current')!.textContent ?? '',
        width: (panel.element.querySelector('.job-progress-fill') as HTMLElement).style.width,
        hidden: wrap.hasAttribute('hidden')
    };
};
/** Past refreshSoon()'s delay, and the async list load after it. */
const settle = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(150);
};

beforeEach(() => {
    vi.useFakeTimers();
    stream = new FakeStream();
    api.schedules = [schedule('s1')];
    api.jobs = [];
    api.listCalls = 0;
});

afterEach(() => {
    panel?.destroy();
    vi.useRealTimers();
});

describe('JobsPanel and `job` events', () => {
    it('moves the bar of a listed run from its updates', async () => {
        const running = job('j1');
        api.jobs = [running];
        await shown();
        expect(row()).toMatchObject({label: '0/10', hidden: false});

        stream.job(update({...running, progress: {done: 5, total: 10, failed: 0, current: 'Notes/a.md'}}));
        expect(row()).toEqual({label: '5/10', current: 'Notes/a.md', width: '50%', hidden: false});
        await settle();
        expect(api.listCalls).toBe(1);
    });

    it('shows the result at the end, then reloads the list once', async () => {
        const running = job('j1');
        api.jobs = [running];
        await shown();

        const done = {...running, status: 'done' as const, summary: 'linked 10', progress: {done: 10, total: 10, failed: 0}};
        stream.job(update(done));
        expect(row().current).toBe('✓ linked 10');
        api.jobs = [done];
        await settle();
        expect(api.listCalls).toBe(2);
        // Finished: the reloaded row has no bar any more.
        expect(row().hidden).toBe(true);
    });

    it('loads a run it does not know yet once per burst (scheduler tick, another tab)', async () => {
        await shown();
        expect(row().hidden).toBe(true);

        const started = job('j2');
        api.jobs = [started];
        for (let done = 0; done < 3; done++) stream.job(update({...started, progress: {done, total: 10, failed: 0}}));
        await settle();
        expect(api.listCalls).toBe(2);
        expect(row()).toMatchObject({label: '0/10', hidden: false});

        // A run without a schedule has no row here: no reload.
        stream.job(update(job('j3', {scheduleId: undefined})));
        await settle();
        expect(api.listCalls).toBe(2);
    });

    it('ignores updates before it was first shown, and reloads after a dropped stream', async () => {
        panel = new JobsPanel({events: stream as unknown as EventStream});
        stream.job(update(job('j1')));
        for (const fn of stream.reconnect) fn();
        await settle();
        expect(api.listCalls).toBe(0);

        await panel.onShow();
        expect(api.listCalls).toBe(1);
        for (const fn of stream.reconnect) fn();
        await settle();
        expect(api.listCalls).toBe(2);
    });

    it('lets go of the stream and a pending reload on destroy', async () => {
        await shown();
        expect(stream.listeners()).toBe(2);
        stream.job(update(job('j9')));
        panel.destroy();
        expect(stream.listeners()).toBe(0);
        await settle();
        expect(api.listCalls).toBe(1);
    });
});
