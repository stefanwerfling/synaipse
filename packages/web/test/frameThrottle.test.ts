import {describe, expect, it} from 'vitest';
import {FrameThrottle} from '../src/FrameThrottle.js';

/** Manual frame clock: `frame()` advances time by 16 ms and fires queued callbacks. */
const clock = () => {
    let t = 0;
    let queue: Array<() => void> = [];
    return {
        now: () => t,
        advance: (ms: number) => {
            t += ms;
        },
        raf: (cb: () => void) => queue.push(cb),
        cancel: (h: number) => {
            queue[h - 1] = () => {};
        },
        frame: () => {
            t += 16;
            const run = queue;
            queue = [];
            run.forEach((cb) => cb());
        }
    };
};

describe('FrameThrottle', () => {
    it('coalesces many requests into one run per frame', () => {
        const c = clock();
        let runs = 0;
        const throttle = new FrameThrottle(() => runs++, c);

        for (let i = 0; i < 500; i++) throttle.request();
        c.frame();
        expect(runs).toBe(1);
        expect(throttle.pending).toBe(false);

        c.frame();
        expect(runs).toBe(1); // nothing requested, nothing run
    });

    it('backs off when a run is expensive', () => {
        const c = clock();
        let runs = 0;
        // Each run costs 40 ms; with spacing 3 the next may start 120 ms later.
        const throttle = new FrameThrottle(() => {
            runs++;
            c.advance(40);
        }, c);

        throttle.request();
        c.frame();
        expect(runs).toBe(1);

        throttle.request();
        for (let i = 0; i < 4; i++) c.frame(); // +64 ms after the 40 ms run: still too early
        expect(runs).toBe(1);
        expect(throttle.pending).toBe(true);

        for (let i = 0; i < 3; i++) c.frame();
        expect(runs).toBe(2);
    });

    it('cancel drops the pending run', () => {
        const c = clock();
        let runs = 0;
        const throttle = new FrameThrottle(() => runs++, c);
        throttle.request();
        throttle.cancel();
        c.frame();
        expect(runs).toBe(0);
    });
});
