import {describe, it, expect, vi} from 'vitest';
import {Disposables} from '../src/Disposables.js';

/** Plan P3 / D1: one dispose() releases listeners, timers and subscriptions. */

describe('Disposables', () => {
    it('removes listeners registered via listen()', () => {
        const target = new EventTarget();
        const handler = vi.fn();
        const life = new Disposables();
        life.listen(target, 'ping', handler);
        target.dispatchEvent(new Event('ping'));
        life.dispose();
        target.dispatchEvent(new Event('ping'));
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('clears timers and intervals', async () => {
        const fn = vi.fn();
        const life = new Disposables();
        life.timeout(fn, 5);
        life.interval(fn, 5);
        life.dispose();
        await new Promise((r) => setTimeout(r, 25));
        expect(fn).not.toHaveBeenCalled();
    });

    it('runs added cleanups in reverse order, keeps going after a failure, and only once', () => {
        const order: string[] = [];
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const life = new Disposables();
        life.add(() => order.push('fn'));
        life.add({destroy: () => order.push('destroy')});
        life.add(() => { throw new Error('boom'); });
        life.add({stop: () => order.push('stop')});
        life.add(null);
        life.dispose();
        life.dispose();
        expect(order).toEqual(['stop', 'destroy', 'fn']);
        expect(warn).toHaveBeenCalledOnce();
        warn.mockRestore();
    });

    it('cleans up immediately what is added after dispose', () => {
        const life = new Disposables();
        life.dispose();
        const fn = vi.fn();
        life.add(fn);
        expect(fn).toHaveBeenCalledOnce();
        expect(life.signal.aborted).toBe(true);
    });
});
