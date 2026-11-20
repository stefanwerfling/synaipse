import type {Page} from '@playwright/test';
import {expect, test} from './fixtures';

/**
 * mount()/unmount() in a host page (plan G3, KPI "listener leaks after
 * unmount = 0"). An init script counts global listeners, intervals and
 * EventSources, so the test sees what Synaipse leaves behind.
 */
test.beforeEach(async ({page}) => {
    await page.addInitScript(() => {
        const listeners = new Set<string>();
        const intervals = new Set<number>();
        const sources = new Set<EventSource>();
        const ids = new WeakMap<object, number>();
        let next = 0;
        const idOf = (o: object): number => {
            let id = ids.get(o);
            if (id === undefined) ids.set(o, (id = ++next));
            return id;
        };
        const keyOf = (target: EventTarget, type: string, fn: unknown, opts: unknown): string | null => {
            if (target !== window && target !== document) return null;
            if (typeof fn !== 'function' && (typeof fn !== 'object' || fn === null)) return null;
            const capture = typeof opts === 'boolean' ? opts : Boolean((opts as {capture?: boolean} | undefined)?.capture);
            return `${target === window ? 'w' : 'd'}:${type}:${idOf(fn as object)}:${capture}`;
        };
        const add = EventTarget.prototype.addEventListener;
        const remove = EventTarget.prototype.removeEventListener;
        EventTarget.prototype.addEventListener = function (type: string, fn: never, opts?: never) {
            const key = keyOf(this, type, fn, opts);
            if (key !== null) {
                listeners.add(key);
                const signal = (opts as {signal?: AbortSignal} | undefined)?.signal;
                signal?.addEventListener('abort', () => listeners.delete(key));
            }
            return add.call(this, type, fn, opts);
        };
        EventTarget.prototype.removeEventListener = function (type: string, fn: never, opts?: never) {
            const key = keyOf(this, type, fn, opts);
            if (key !== null) listeners.delete(key);
            return remove.call(this, type, fn, opts);
        };
        const setI = window.setInterval.bind(window);
        const clearI = window.clearInterval.bind(window);
        window.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
            const id = setI(fn, ms, ...args);
            intervals.add(id);
            return id;
        }) as typeof window.setInterval;
        window.clearInterval = ((id?: number) => {
            if (id !== undefined) intervals.delete(id);
            clearI(id);
        }) as typeof window.clearInterval;
        const ES = window.EventSource;
        window.EventSource = class extends ES {
            constructor(url: string | URL, init?: EventSourceInit) {
                super(url, init);
                sources.add(this);
            }
        } as typeof EventSource;
        (window as unknown as {__leaks: () => unknown}).__leaks = () => ({
            listeners: [...listeners].sort(),
            intervals: intervals.size,
            openSources: [...sources].filter((s) => s.readyState !== EventSource.CLOSED).length
        });
    });
});

interface Leaks {listeners: string[]; intervals: number; openSources: number}
type Host = {
    __leaks: () => Leaks;
    __mount: () => Promise<boolean>;
    __unmount: () => Promise<boolean>;
    __navigate: (route: string) => Promise<void>;
    __routes: string[];
    __hostReady?: boolean;
};
const leaks = (page: Page) => page.evaluate(() => (window as unknown as Host).__leaks());

/** Mount, open a note and the graph, unmount; checks the container and portal are gone. */
const cycle = async (page: Page): Promise<void> => {
    const host = page.locator('#host');
    await page.evaluate(() => (window as unknown as Host).__mount());
    await expect(host.locator('.note-list-item')).toHaveCount(5);
    await expect(host).toHaveAttribute('data-theme', 'light');
    expect((await leaks(page)).openSources).toBeGreaterThan(0);

    await page.evaluate(() => (window as unknown as Host).__navigate('#/notes/Memory/demo/Architecture.md'));
    await expect(host.getByRole('heading', {name: /Linked from/})).toBeVisible();
    await page.evaluate(() => (window as unknown as Host).__navigate('#/graph'));
    await expect(host.locator('canvas').first()).toBeVisible();

    await page.evaluate(() => (window as unknown as Host).__unmount());
    await page.waitForTimeout(200);
    expect(await host.evaluate((el) => el.childElementCount)).toBe(0);
    await expect(page.locator('.synaipse-portal')).toHaveCount(0);
};

test('mount, use and unmount leave nothing behind', async ({page, errors}) => {
    await page.goto('/embed-host.html');
    await page.waitForFunction(() => (window as unknown as Host).__hostReady === true);
    const before = await leaks(page);

    // First cycle: lazy chunks load and create their module-level state
    // once (e.g. the 2D position store); that is not per mount.
    await cycle(page);
    const first = await leaks(page);
    expect(first.openSources).toBe(0);
    expect(first.intervals).toBe(before.intervals);
    expect(await page.evaluate(() => (window as unknown as Host).__routes.length)).toBeGreaterThan(0);
    expect(page.url()).toMatch(/embed-host\.html$/); // routing 'none': the host owns the URL

    // Every further cycle must end exactly where the first one did.
    await cycle(page);
    expect(await leaks(page)).toEqual(first);
    await cycle(page);
    expect(await leaks(page)).toEqual(first);
    expect(errors).toEqual([]);
});
