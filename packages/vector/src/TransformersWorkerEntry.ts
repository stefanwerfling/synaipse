import {workerData} from 'node:worker_threads';
import {serveWorkerRpc} from '@synaipse/core/worker-rpc';
import type {EmbedderInputType} from './Embedder.js';
import {HuggingFaceEmbedder, type HuggingFaceEmbedderOptions} from './HuggingFace.js';
import {HuggingFaceReranker, type HuggingFaceRerankerOptions} from './Reranker.js';

/**
 * worker_threads entry hosting the local transformer models (plan P4 /
 * A3): ONNX inference for embeddings and reranking runs here instead of
 * on the server's event loop. Each model is loaded once, on first use.
 */
interface TransformersWorkerData {
    embedder?: HuggingFaceEmbedderOptions;
    reranker?: HuggingFaceRerankerOptions;
}

const data = (workerData ?? {}) as TransformersWorkerData;
const embedder = data.embedder === undefined ? null : new HuggingFaceEmbedder(data.embedder);
const reranker = data.reranker === undefined ? null : new HuggingFaceReranker(data.reranker);

serveWorkerRpc({
    embed: async (texts: string[], inputType: EmbedderInputType) => {
        if (embedder === null) throw new Error('no embedder configured in this worker');
        return embedder.embed(texts, inputType);
    },
    score: async (query: string, passages: string[]) => {
        if (reranker === null) throw new Error('no reranker configured in this worker');
        return reranker.score(query, passages);
    }
});
