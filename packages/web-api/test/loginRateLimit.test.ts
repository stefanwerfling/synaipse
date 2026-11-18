import {describe, it, expect} from 'vitest';
import {LoginRateLimit} from '../server/login-rate-limit.js';

describe('LoginRateLimit', () => {
    it('allows attempts up to the configured max', () => {
        const rl = new LoginRateLimit({maxAttempts: 3, windowMs: 60_000, nowSource: () => 0});
        expect(rl.hit('a')).toBe(2);  // 3-1
        expect(rl.hit('a')).toBe(1);
        expect(rl.hit('a')).toBe(0);  // limit reached, this one was still allowed
    });

    it('returns negative once over the limit', () => {
        const rl = new LoginRateLimit({maxAttempts: 2, windowMs: 60_000, nowSource: () => 0});
        rl.hit('x');
        rl.hit('x');
        expect(rl.hit('x')).toBeLessThan(0);
    });

    it('buckets are per-key (distinct IPs do not interfere)', () => {
        const rl = new LoginRateLimit({maxAttempts: 1, windowMs: 60_000, nowSource: () => 0});
        rl.hit('alice');
        expect(rl.hit('alice')).toBeLessThan(0);
        // bob's bucket is untouched
        expect(rl.hit('bob')).toBe(0);
    });

    it('older attempts age out of the sliding window', () => {
        let now = 0;
        const rl = new LoginRateLimit({maxAttempts: 2, windowMs: 1000, nowSource: () => now});
        rl.hit('x');
        rl.hit('x');
        expect(rl.hit('x')).toBeLessThan(0);
        now = 1500;
        // older attempts now outside the 1s window
        expect(rl.hit('x')).toBeGreaterThanOrEqual(0);
    });

    it('reset clears the bucket', () => {
        const rl = new LoginRateLimit({maxAttempts: 1, windowMs: 60_000, nowSource: () => 0});
        rl.hit('x');
        rl.reset('x');
        // Bucket gone — first hit is fresh.
        expect(rl.hit('x')).toBe(0);
    });

    it('sweep removes buckets with only expired attempts', () => {
        let now = 0;
        const rl = new LoginRateLimit({maxAttempts: 5, windowMs: 1000, nowSource: () => now});
        rl.hit('a');
        rl.hit('b');
        now = 2000;
        expect(rl.sweep()).toBe(2);
    });

    it('sweep keeps buckets that still have in-window attempts', () => {
        let now = 0;
        const rl = new LoginRateLimit({maxAttempts: 5, windowMs: 1000, nowSource: () => now});
        rl.hit('a');
        now = 1500;
        rl.hit('a');  // still in window relative to new now
        expect(rl.sweep()).toBe(0);
    });
});