import {VectorError} from '@synaipse/core';
import type {Embedder, EmbedderInputType} from './Embedder.js';

export interface OllamaEmbedderOptions {
    url: string;
    model: string;
    dimension: number;
    documentPrefix?: string;
    queryPrefix?: string;
}

interface OllamaResponse {
    embeddings: number[][];
    model: string;
}

const DEFAULT_PREFIXES_BY_MODEL: Record<string, {document: string; query: string}> = {
    'nomic-embed-text': {document: 'search_document: ', query: 'search_query: '}
};

const stripTag = (model: string): string => model.split(':')[0] ?? model;

export class OllamaEmbedder implements Embedder {
    public readonly dimension: number;
    private readonly documentPrefix: string;
    private readonly queryPrefix: string;
    private readonly endpoint: string;

    public constructor(private readonly options: OllamaEmbedderOptions) {
        this.dimension = options.dimension;
        const defaults = DEFAULT_PREFIXES_BY_MODEL[stripTag(options.model)] ?? {document: '', query: ''};
        this.documentPrefix = options.documentPrefix ?? defaults.document;
        this.queryPrefix = options.queryPrefix ?? defaults.query;
        this.endpoint = `${options.url.replace(/\/$/, '')}/api/embed`;
    }

    public async embed(texts: string[], inputType: EmbedderInputType): Promise<number[][]> {
        if (texts.length === 0) {
            return [];
        }

        const prefix = inputType === 'document' ? this.documentPrefix : this.queryPrefix;
        const inputs = prefix.length === 0 ? texts : texts.map((t) => `${prefix}${t}`);

        let response: Response;

        try {
            response = await fetch(this.endpoint, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({model: this.options.model, input: inputs})
            });
        } catch (error) {
            throw new VectorError(
                `Ollama network error: ${error instanceof Error ? error.message : String(error)}`,
                error
            );
        }

        if (!response.ok) {
            const body = await response.text();
            throw new VectorError(`Ollama API error ${response.status}: ${body}`);
        }

        const payload = (await response.json()) as OllamaResponse;

        if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== texts.length) {
            throw new VectorError(`Ollama returned ${payload.embeddings?.length ?? 0} embeddings for ${texts.length} inputs`);
        }

        return payload.embeddings;
    }

    public async embedOne(text: string, inputType: EmbedderInputType): Promise<number[]> {
        const [vector] = await this.embed([text], inputType);

        if (!vector) {
            throw new VectorError('Ollama returned no embedding');
        }

        return vector;
    }
}