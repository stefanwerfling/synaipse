import {createLogger} from '@synaipse/core';
import {WorkerRpc} from '@synaipse/core/worker-rpc';
import {computeLayout, type GraphInput, type GraphLayout} from './Layout.js';

const log = createLogger('layout');

/**
 * Runs {@link computeLayout} off the main thread (plan P4 / A3).
 *
 * One lazily started worker serves all requests in order. When the
 * compiled worker entry is missing (vitest runs the TypeScript sources)
 * or the worker cannot start, it computes in-process instead, so callers
 * never have to care. A crashed worker rejects what it had in flight and
 * is restarted on the next request.
 */
export class LayoutComputer {

    private readonly rpc: WorkerRpc;
    private closed = false;

    public constructor(entry: URL = new URL('./LayoutWorkerEntry.js', import.meta.url)) {
        this.rpc = new WorkerRpc(entry, 'layout');
    }

    /** True when requests go to a worker thread rather than the calling thread. */
    public get offThread(): boolean {
        return this.rpc.available;
    }

    public async compute(input: GraphInput): Promise<GraphLayout> {
        if (this.closed) {
            throw new Error('LayoutComputer is closed');
        }

        if (this.rpc.available) {
            try {
                return await this.rpc.call<GraphLayout>('computeLayout', input);
            } catch (error) {
                if (this.rpc.available) throw error;
                log.warn('layout worker unavailable, computing in-process', {error: error instanceof Error ? error.message : String(error)});
            }
        }

        // Yield once so even the fallback never runs inside the caller's tick.
        await new Promise<void>((resolve) => setImmediate(resolve));
        return computeLayout(input);
    }

    public async close(): Promise<void> {
        this.closed = true;
        await this.rpc.close();
    }

}
