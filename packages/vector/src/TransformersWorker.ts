import {createLogger} from '@synaipse/core';
import {WorkerRpc} from '@synaipse/core/worker-rpc';
import type {Embedder, EmbedderInputType} from './Embedder.js';
import {HuggingFaceEmbedder, type HuggingFaceEmbedderOptions} from './HuggingFace.js';
import {HuggingFaceReranker, type HuggingFaceRerankerOptions, type Reranker} from './Reranker.js';

const log = createLogger('transformers');

/**
 * Local transformer models in a worker thread (plan P4 / A3). One worker
 * hosts the embedder and the reranker together, so a process loads each
 * model once. Without a compiled worker entry (vitest) or when the
 * worker cannot start, the models run in-process as before.
 */
export class TransformersHost {

    private readonly rpc: WorkerRpc;
    private localEmbedder: HuggingFaceEmbedder | null = null;
    private localReranker: HuggingFaceReranker | null = null;

    public constructor(
        private readonly options: {embedder?: HuggingFaceEmbedderOptions; reranker?: HuggingFaceRerankerOptions},
        entry: URL = new URL('./TransformersWorkerEntry.js', import.meta.url)
    ) {
        this.rpc = new WorkerRpc(entry, 'transformers', options);
    }

    public get offThread(): boolean {
        return this.rpc.available;
    }

    public async embed(texts: string[], inputType: EmbedderInputType): Promise<number[][]> {
        if (texts.length === 0) return [];

        return this.run(
            () => this.rpc.call<number[][]>('embed', texts, inputType),
            () => {
                if (this.options.embedder === undefined) throw new Error('no embedder configured');
                this.localEmbedder ??= new HuggingFaceEmbedder(this.options.embedder);
                return this.localEmbedder.embed(texts, inputType);
            }
        );
    }

    public async score(query: string, passages: string[]): Promise<number[]> {
        return this.run(
            () => this.rpc.call<number[]>('score', query, passages),
            () => {
                if (this.options.reranker === undefined) throw new Error('no reranker configured');
                this.localReranker ??= new HuggingFaceReranker(this.options.reranker);
                return this.localReranker.score(query, passages);
            }
        );
    }

    public close(): Promise<void> {
        return this.rpc.close();
    }

    private async run<T>(remote: () => Promise<T>, local: () => Promise<T>): Promise<T> {
        if (this.rpc.available) {
            try {
                return await remote();
            } catch (error) {
                // Errors from the model itself are real; only a worker that
                // could not start at all falls back to in-process.
                if (this.rpc.available) throw error;
                log.warn('transformers worker unavailable, running in-process', {error: error instanceof Error ? error.message : String(error)});
            }
        }

        return local();
    }

}

/** {@link Embedder} backed by a {@link TransformersHost}. */
export class WorkerHuggingFaceEmbedder implements Embedder {

    public constructor(private readonly host: TransformersHost, public readonly dimension: number) {
    }

    public embed(texts: string[], inputType: EmbedderInputType): Promise<number[][]> {
        return this.host.embed(texts, inputType);
    }

    public async embedOne(text: string, inputType: EmbedderInputType): Promise<number[]> {
        const [vector] = await this.host.embed([text], inputType);
        if (vector === undefined) throw new Error('HuggingFace returned no embedding');
        return vector;
    }

}

/** {@link Reranker} backed by a {@link TransformersHost}. */
export class WorkerHuggingFaceReranker implements Reranker {

    public constructor(private readonly host: TransformersHost, public readonly model: string) {
    }

    public score(query: string, passages: string[]): Promise<number[]> {
        return this.host.score(query, passages);
    }

}
