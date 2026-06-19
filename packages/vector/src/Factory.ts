import {ConfigError} from '@synaipse/core';
import type {Config} from '@synaipse/core';
import type {Embedder} from './Embedder.js';
import {OllamaEmbedder} from './Ollama.js';
import {VoyageEmbedder} from './Embeddings.js';
import {HuggingFaceEmbedder} from './HuggingFace.js';

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
                    process.stderr.write(`[synaipse] voyage retry #${attempt} reason=${reason} wait=${waitMs}ms\n`);
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

        return new HuggingFaceEmbedder({
            model: config.huggingface.model,
            dimension
        });
    }

    throw new ConfigError(`unknown embeddings provider: ${String(provider)}`);
};