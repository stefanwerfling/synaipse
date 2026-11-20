import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parentPort, Worker} from 'node:worker_threads';
import {createLogger} from './Log.js';

const log = createLogger('worker');

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

interface RpcRequest {
    id: number;
    method: string;
    args: unknown[];
}

type RpcResponse = {id: number; result: unknown} | {id: number; error: string};

/**
 * Minimal request/response channel to one `worker_threads` worker (plan
 * P4 / A3), used to move CPU-heavy work (Atlas layout, local transformer
 * models) off the event loop.
 *
 * - The worker starts lazily on the first call and is restarted after a
 *   crash; calls in flight when it died are rejected.
 * - It only keeps the process alive while calls are in flight.
 * - `available` is false when the entry file does not exist (vitest runs
 *   the TypeScript sources, where no compiled entry is next to them) or
 *   the worker could not be started; callers then do the work in-process.
 */
export class WorkerRpc {

    private worker: Worker | null = null;
    private failed = false;
    private closed = false;
    private seq = 0;
    private readonly pending = new Map<number, Pending>();

    public constructor(
        private readonly entry: URL,
        private readonly name: string,
        private readonly workerData?: unknown
    ) {
    }

    public get available(): boolean {
        return !this.failed && !this.closed && existsSync(fileURLToPath(this.entry));
    }

    public async call<T>(method: string, ...args: unknown[]): Promise<T> {
        return this.callTransfer<T>(method, args, []);
    }

    /** Like {@link call}, moving `transfer` (ArrayBuffers inside `args`) instead of copying them. */
    public async callTransfer<T>(method: string, args: unknown[], transfer: ArrayBuffer[]): Promise<T> {
        if (this.closed) {
            throw new Error(`${this.name} worker is closed`);
        }

        const worker = this.ensureWorker();
        const id = ++this.seq;

        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, {resolve: resolve as (value: unknown) => void, reject});
            worker.ref();
            worker.postMessage({id, method, args} satisfies RpcRequest, transfer);
        });
    }

    public async close(): Promise<void> {
        this.closed = true;
        this.failPending(new Error(`${this.name} worker closed`));
        const worker = this.worker;
        this.worker = null;

        if (worker !== null) {
            await worker.terminate();
        }
    }

    private ensureWorker(): Worker {
        if (this.worker !== null) {
            return this.worker;
        }

        let worker: Worker;
        try {
            worker = new Worker(this.entry, this.workerData === undefined ? {} : {workerData: this.workerData});
        } catch (error) {
            this.failed = true;
            throw error;
        }

        worker.on('message', (message: RpcResponse) => {
            const entry = this.pending.get(message.id);

            if (entry === undefined) {
                return;
            }

            this.pending.delete(message.id);

            if (this.pending.size === 0) {
                worker.unref();
            }

            if ('error' in message) {
                entry.reject(new Error(message.error));
            } else {
                entry.resolve(message.result);
            }
        });
        worker.on('error', (error) => {
            log.warn('worker crashed', {worker: this.name, error: error.message});
            if (this.worker === worker) this.worker = null;
            this.failPending(error);
        });
        worker.on('exit', (code) => {
            if (this.worker === worker) {
                this.worker = null;

                if (code !== 0 && !this.closed) {
                    this.failPending(new Error(`${this.name} worker exited with code ${code}`));
                }
            }
        });
        worker.unref();
        this.worker = worker;
        return worker;
    }

    private failPending(error: Error): void {
        for (const entry of this.pending.values()) {
            entry.reject(error);
        }

        this.pending.clear();
    }

}

/**
 * Worker side of {@link WorkerRpc}: dispatches each request to
 * `handlers[method]` and posts back its result or error message.
 */
export const serveWorkerRpc = (handlers: Record<string, (...args: never[]) => unknown>): void => {
    parentPort?.on('message', (request: RpcRequest) => {
        void (async () => {
            try {
                const handler = handlers[request.method];

                if (handler === undefined) {
                    throw new Error(`unknown worker method: ${request.method}`);
                }

                const result = await (handler as (...args: unknown[]) => unknown)(...request.args);
                parentPort?.postMessage({id: request.id, result} satisfies RpcResponse);
            } catch (error) {
                const text = error instanceof Error ? error.stack ?? error.message : String(error);
                parentPort?.postMessage({id: request.id, error: text} satisfies RpcResponse);
            }
        })();
    });
};
