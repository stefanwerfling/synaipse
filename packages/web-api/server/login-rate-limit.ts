interface Bucket {
    attempts: number[];  // epoch ms timestamps of attempts within the window
}

export interface LoginRateLimitOptions {
    /** Max attempts allowed in `windowMs` before subsequent attempts get 429. */
    maxAttempts?: number;
    windowMs?: number;
    nowSource?: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 60_000;

/**
 * Per-key sliding-window rate limiter. Used to throttle login attempts
 * per client IP so a stolen email isn't trivially brute-forced through
 * the password endpoint. Keys can also be `${ip}:${email}` if we ever
 * want per-account limiting; v1 sticks to per-IP because that's the
 * actor we can actually slow down.
 */
export class LoginRateLimit {
    private readonly buckets = new Map<string, Bucket>();
    private readonly maxAttempts: number;
    private readonly windowMs: number;
    private readonly now: () => number;

    public constructor(opts: LoginRateLimitOptions = {}) {
        this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
        this.now = opts.nowSource ?? Date.now;
    }

    /**
     * Record an attempt for the given key. Returns the number of attempts
     * still allowed within the window (after this one); negative when
     * over-limit. Caller turns negative results into HTTP 429.
     */
    public hit(key: string): number {
        const now = this.now();
        const cutoff = now - this.windowMs;

        const bucket = this.buckets.get(key) ?? {attempts: []};
        const recent = bucket.attempts.filter((t) => t > cutoff);
        recent.push(now);
        bucket.attempts = recent;
        this.buckets.set(key, bucket);

        return this.maxAttempts - recent.length;
    }

    /**
     * Reset the bucket for the given key — call on successful login so a
     * legitimate user who fat-fingered their password a few times isn't
     * locked out after they get it right.
     */
    public reset(key: string): void {
        this.buckets.delete(key);
    }

    /**
     * Drop empty / fully-expired buckets to bound memory growth under
     * scan attacks. Optional housekeeping; not called automatically.
     */
    public sweep(): number {
        const cutoff = this.now() - this.windowMs;
        let count = 0;
        for (const [key, bucket] of this.buckets) {
            const recent = bucket.attempts.filter((t) => t > cutoff);
            if (recent.length === 0) {
                this.buckets.delete(key);
                count += 1;
            } else {
                bucket.attempts = recent;
            }
        }
        return count;
    }
}