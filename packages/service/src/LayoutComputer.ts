import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {createLogger} from '@synaipse/core';
import {computeLayout, type GraphInput, type GraphLayout} from './Layout.js';

const log = createLogger('layout');

interface Pending {
    resolve: (layout: GraphLayout) => void;
    reject: (error: Error) => void;
}

/**
 * Runs {@link computeLayout} off the main thread (plan P4 / A3).
 *
 * One lazily started worker serves all requests in order. When the
 * compiled worker entry is missing (vitest runs the TypeScript sources)
 * or the worker cannot start, it falls back to computing in-process, so
 * callers never have to care. A crashed worker rejects what it had in
 * flight and is restarted on the next request.
 */
export class LayoutComputer {

    private worker: Worker | null = null;
    private disabled = false;
    private closed = false;
    private seq = 0;
    private readonly pending = new Map<number, Pending>();

    public constructor(
        private readonly entry: URL = new URL('./LayoutWorkerEntry.js', import.meta.url),
        private readonly useWorker = true
    ) {
    }

    /** True when requests go to a worker thread rather than the calling thread. */
    public get offThread(): boolean {
        return this.useWorker && !this.disabled && existsSync(fileURLToPath(this.entry));
    }

    public async compute(input: GraphInput): Promise<GraphLayout> {
        if (this.closed) {
            throw new Error('LayoutComputer is closed');
        }

        const worker = this.offThread ? this.ensureWorker() : null;

        if (worker === null) {
            // Yield once so even the fallback never runs inside the caller's tick.
            await new Promise<void>((resolve) => setImmediate(resolve));
            return computeLayout(input);
        }

        const id = ++this.seq;

        return new Promise<GraphLayout>((resolve, reject) => {
            this.pending.set(id, {resolve, reject});
            // Hold the process open while work is in flight, not while idle.
            worker.ref();
            worker.postMessage({id, input});
        });
    }

    public async close(): Promise<void> {
        this.closed = true;
        this.failPending(new Error('LayoutComputer closed'));
        const worker = this.worker;
        this.worker = null;

        if (worker !== null) {
            await worker.terminate();
        }
    }

    private ensureWorker(): Worker | null {
        if (this.worker !== null) {
            return this.worker;
        }

        try {
            const worker = new Worker(this.entry);

            worker.on('message', (message: {id: number; layout?: GraphLayout; error?: string}) => {
                const entry = this.pending.get(message.id);

                if (entry === undefined) {
                    return;
                }

                this.pending.delete(message.id);

                if (this.pending.size === 0) {
                    worker.unref();
                }

                if (message.layout !== undefined) {
                    entry.resolve(message.layout);
                } else {
                    entry.reject(new Error(message.error ?? 'layout worker failed'));
                }
            });
            worker.on('error', (error) => {
                log.warn('layout worker crashed', {error: error.message});
                this.failPending(error);
                this.worker = null;
            });
            worker.on('exit', (code) => {
                if (this.worker === worker) {
                    this.worker = null;

                    if (code !== 0 && !this.closed) {
                        this.failPending(new Error(`layout worker exited with code ${code}`));
                    }
                }
            });
            // Never keep the process alive just for an idle worker.
            worker.unref();
            this.worker = worker;
            return worker;
        } catch (error) {
            log.warn('layout worker unavailable, computing in-process', {error: error instanceof Error ? error.message : String(error)});
            this.disabled = true;
            return null;
        }
    }

    private failPending(error: Error): void {
        for (const entry of this.pending.values()) {
            entry.reject(error);
        }

        this.pending.clear();
    }

}
