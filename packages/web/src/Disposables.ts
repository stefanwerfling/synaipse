/**
 * Lifetime of a view (plan P3 / D1). Everything a view starts — DOM
 * listeners on window/document, timers, animation frames, subscriptions —
 * is registered here and released by one `dispose()`. That is what makes
 * `unmount()` in an embedding host (PKG Studio) leave nothing behind.
 *
 *   const life = new Disposables();
 *   life.listen(document, 'keydown', onKey);
 *   life.interval(tick, 1000);
 *   life.add(store.subscribe(render));
 *   …
 *   life.dispose();
 */
export class Disposables {
    private readonly controller = new AbortController();
    private readonly cleanups: (() => void)[] = [];

    /** Pass to `addEventListener(…, {signal})` or `fetch(…, {signal})`. */
    public get signal(): AbortSignal {
        return this.controller.signal;
    }

    public get disposed(): boolean {
        return this.controller.signal.aborted;
    }

    public listen<K extends keyof WindowEventMap>(
        target: Window, type: K, handler: (event: WindowEventMap[K]) => void, options?: AddEventListenerOptions
    ): void;
    public listen<K extends keyof DocumentEventMap>(
        target: Document, type: K, handler: (event: DocumentEventMap[K]) => void, options?: AddEventListenerOptions
    ): void;
    public listen(target: EventTarget, type: string, handler: (event: Event) => void, options?: AddEventListenerOptions): void;
    public listen(target: EventTarget, type: string, handler: (event: never) => void, options: AddEventListenerOptions = {}): void {
        if (this.disposed) return;
        target.addEventListener(type, handler as EventListener, {...options, signal: this.signal});
    }

    public timeout(fn: () => void, ms: number): void {
        if (this.disposed) return;
        const id = setTimeout(fn, ms);
        this.cleanups.push(() => clearTimeout(id));
    }

    public interval(fn: () => void, ms: number): void {
        if (this.disposed) return;
        const id = setInterval(fn, ms);
        this.cleanups.push(() => clearInterval(id));
    }

    /** Register any teardown: an unsubscribe function or an object with destroy/stop/close. */
    public add(item: (() => void) | {destroy(): void} | {stop(): void} | {close(): void} | null | undefined): void {
        if (item === null || item === undefined) return;
        const fn = typeof item === 'function'
            ? item
            : 'destroy' in item ? () => item.destroy()
                : 'stop' in item ? () => item.stop()
                    : () => item.close();
        if (this.disposed) {
            fn();
            return;
        }
        this.cleanups.push(fn);
    }

    /** Runs cleanups in reverse order; one failing cleanup doesn't stop the rest. Idempotent. */
    public dispose(): void {
        if (this.disposed) return;
        this.controller.abort();
        const errors: unknown[] = [];
        for (const fn of this.cleanups.splice(0).reverse()) {
            try {
                fn();
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length > 0) {
            console.warn('[synaipse] cleanup failed', errors);
        }
    }
}
