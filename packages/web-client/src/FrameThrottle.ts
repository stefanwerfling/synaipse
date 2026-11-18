export interface FrameThrottleOptions {
    /** Defaults to `requestAnimationFrame`. */
    raf?: (cb: () => void) => number;
    /** Defaults to `cancelAnimationFrame`. */
    cancel?: (handle: number) => void;
    /** Defaults to `performance.now`. */
    now?: () => number;
    /**
     * After a run that took `t` ms the next one waits until `t × spacing`
     * ms after its start, so rendering never takes more than 1/spacing of
     * the time however expensive it gets. Default 3 (≤ 33 %).
     */
    spacing?: number;
}

/**
 * Coalesces many `request()` calls (one per streamed token) into at most
 * one `run()` per animation frame, and backs off adaptively when `run()`
 * is expensive (long markdown answers). Plan P4 / D5.
 */
export class FrameThrottle {
    private readonly raf: (cb: () => void) => number;
    private readonly cancelFrame: (handle: number) => void;
    private readonly now: () => number;
    private readonly spacing: number;
    private handle: number | null = null;
    private notBefore = 0;

    public constructor(private readonly run: () => void, opts: FrameThrottleOptions = {}) {
        this.raf = opts.raf ?? ((cb) => requestAnimationFrame(cb));
        this.cancelFrame = opts.cancel ?? ((h) => cancelAnimationFrame(h));
        this.now = opts.now ?? (() => performance.now());
        this.spacing = opts.spacing ?? 3;
    }

    /** Ask for a run; any number of calls before the next frame cost one run. */
    public request(): void {
        if (this.handle !== null) return;
        this.handle = this.raf(() => this.tick());
    }

    /** Drop a pending run (e.g. the caller renders everything right now). */
    public cancel(): void {
        if (this.handle !== null) {
            this.cancelFrame(this.handle);
            this.handle = null;
        }
    }

    public get pending(): boolean {
        return this.handle !== null;
    }

    private tick(): void {
        this.handle = null;
        const start = this.now();

        if (start < this.notBefore) {
            this.handle = this.raf(() => this.tick());
            return;
        }

        this.run();
        this.notBefore = start + (this.now() - start) * this.spacing;
    }
}
