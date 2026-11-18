import {ConfigError, createLogger} from '@synaipse/core';
import type {Config} from '@synaipse/core';
import type {Embedder} from './Embedder.js';
import {OllamaEmbedder} from './Ollama.js';
import {VoyageEmbedder} from './Embeddings.js';
import {HuggingFaceEmbedder} from './HuggingFace.js';
import type {Reranker} from './Reranker.js';
import {TransformersHost, WorkerHuggingFaceEmbedder, WorkerHuggingFaceReranker} from './TransformersWorker.js';
import {HuggingFaceReranker} from './Reranker.js';

const log = createLogger('vector');

const VOYAGE_DIMS: Record<string, number> = {
    'voyage-3-large': 1024,
    'voyage-3': 1024,
    'voyage-3-lite': 512,
    'voyage-code-3': 1024
};

const OLLAMA_DIMS: Record<string, number> = {
    'nomic-embed-text': 768,
    'mxbai-embed-large': 1024,
    'all-minilm': 384,
    'snowflake-arctic-embed': 1024,
    'bge-m3': 1024
};

const HUGGINGFACE_DIMS: Record<string, number> = {
    'Xenova/all-MiniLM-L6-v2': 384,
    'Xenova/all-MiniLM-L12-v2': 384,
    'Xenova/all-mpnet-base-v2': 768,
    'Xenova/bge-small-en-v1.5': 384,
    'Xenova/bge-base-en-v1.5': 768,
    'Xenova/bge-large-en-v1.5': 1024,
    'Xenova/multilingual-e5-small': 384,
    'Xenova/multilingual-e5-base': 768,
    'Xenova/multilingual-e5-large': 1024,
    'Xenova/e5-small-v2': 384,
    'Xenova/e5-base-v2': 768
};

const stripTag = (model: string): string => model.split(':')[0] ?? model;

/**
 * One {@link TransformersHost} per config, shared by the HuggingFace
 * embedder and reranker so both models live in the same worker thread.
 * `SYNAIPSE_TRANSFORMERS_WORKER=0` keeps them in-process (old behaviour).
 */
const hosts = new WeakMap<Config, TransformersHost>();

const transformersHost = (config: Config): TransformersHost | null => {
    if (process.env.SYNAIPSE_TRANSFORMERS_WORKER === '0') return null;

    let host = hosts.get(config);
    if (host === undefined) {
        const embedderModel = config.embeddings.provider === 'huggingface' ? config.huggingface?.model : undefined;
        const embedderDim = embedderModel === undefined ? undefined : HUGGINGFACE_DIMS[embedderModel];
        const rerankerModel = config.reranker?.provider === 'huggingface'
            ? config.reranker.model ?? 'Xenova/ms-marco-MiniLM-L-6-v2'
            : undefined;

        host = new TransformersHost({
            ...(embedderModel !== undefined && embedderDim !== undefined ? {embedder: {model: embedderModel, dimension: embedderDim}} : {}),
            ...(rerankerModel !== undefined ? {reranker: {model: rerankerModel}} : {})
        });
        hosts.set(config, host);
    }

    return host;
};

export const createEmbedder = (config: Config): Embedder | null => {
    const provider = config.embeddings.provider;

    if (provider === 'none') {
        return null;
    }

    if (provider === 'voyage') {
        if (config.voyage === undefined) {
            throw new ConfigError('embeddings.provider=voyage but no voyage config provided');
        }

        return new VoyageEmbedder({
            apiKey: config.voyage.apiKey,
            model: config.voyage.model,
            dimension: VOYAGE_DIMS[config.voyage.model] ?? 1024,
            retry: {
                onRetry: ({attempt, reason, waitMs}) => {
                    log.warn('voyage retry', {attempt, reason, waitMs});
                }
            }
        });
    }

    if (provider === 'ollama') {
        if (config.ollama === undefined) {
            throw new ConfigError('embeddings.provider=ollama but no ollama config provided');
        }

        return new OllamaEmbedder({
            url: config.ollama.url,
            model: config.ollama.model,
            dimension: OLLAMA_DIMS[stripTag(config.ollama.model)] ?? 768
        });
    }

    if (provider === 'huggingface') {
        if (config.huggingface === undefined) {
            throw new ConfigError('embeddings.provider=huggingface but no huggingface config provided');
        }

        const dimension = HUGGINGFACE_DIMS[config.huggingface.model];

        if (dimension === undefined) {
            throw new ConfigError(
                `Unknown HuggingFace model dimension for "${config.huggingface.model}". ` +
                `Known models: ${Object.keys(HUGGINGFACE_DIMS).join(', ')}. ` +
                `Add the model + its dimension to HUGGINGFACE_DIMS in packages/vector/src/Factory.ts to use it.`
            );
        }

        const host = transformersHost(config);
        return host === null
            ? new HuggingFaceEmbedder({model: config.huggingface.model, dimension})
            : new WorkerHuggingFaceEmbedder(host, dimension);
    }

    throw new ConfigError(`unknown embeddings provider: ${String(provider)}`);
};

/**
 * Cross-encoder reranker — independent of the embedder. Users can pair
 * a hosted embedder (voyage) with a local reranker (huggingface) so
 * only the retrieval-heavy path hits the API, and the precision-tune
 * runs on-device. Returns null when disabled (default, no config).
 */
export const createReranker = (config: Config): Reranker | null => {
    const cfg = config.reranker;
    if (cfg === undefined) return null;

    if (cfg.provider === 'none') return null;

    if (cfg.provider === 'huggingface') {
        const model = cfg.model ?? 'Xenova/ms-marco-MiniLM-L-6-v2';
        const host = transformersHost(config);
        return host === null ? new HuggingFaceReranker({model}) : new WorkerHuggingFaceReranker(host, model);
    }

    throw new ConfigError(`unknown reranker provider: ${String(cfg.provider)}`);
};

/**
 * Stable identity of the configured embedder: `provider:model:dimension`.
 * Stored per note next to the embedded hash so a model switch (even one
 * with the same dimension) is detected and triggers a re-embed instead of
 * silently mixing two vector spaces. Null when embeddings are disabled.
 */
export const embedderFingerprint = (config: Config, dimension: number): string | null => {
    switch (config.embeddings.provider) {
        case 'voyage':
            return config.voyage === undefined ? null : `voyage:${config.voyage.model}:${dimension}`;
        case 'ollama':
            return config.ollama === undefined ? null : `ollama:${stripTag(config.ollama.model)}:${dimension}`;
        case 'huggingface':
            return config.huggingface === undefined ? null : `huggingface:${config.huggingface.model}:${dimension}`;
        default:
            return null;
    }
};
