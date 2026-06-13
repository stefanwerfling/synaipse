import {ConfigError} from '@synaipse/core';
import type {Config} from '@synaipse/core';
import type {Embedder} from './Embedder.js';
import {OllamaEmbedder} from './Ollama.js';
import {VoyageEmbedder} from './Embeddings.js';

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

    throw new ConfigError(`unknown embeddings provider: ${String(provider)}`);
};