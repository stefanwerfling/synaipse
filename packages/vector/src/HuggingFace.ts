import {VectorError} from '@synaipse/core';
import type {Embedder, EmbedderInputType} from './Embedder.js';

export interface HuggingFaceEmbedderOptions {
    model: string;
    dimension: number;
    documentPrefix?: string;
    queryPrefix?: string;
}

// e5 family expects "passage: " / "query: " prefixes on inputs. Most other
// sentence-transformer models (MiniLM, BGE-small, MPNet) just take raw text.
const DEFAULT_PREFIXES_BY_MODEL: Record<string, {document: string; query: string}> = {
    'Xenova/multilingual-e5-small': {document: 'passage: ', query: 'query: '},
    'Xenova/multilingual-e5-base': {document: 'passage: ', query: 'query: '},
    'Xenova/multilingual-e5-large': {document: 'passage: ', query: 'query: '},
    'Xenova/e5-small-v2': {document: 'passage: ', query: 'query: '},
    'Xenova/e5-base-v2': {document: 'passage: ', query: 'query: '}
};

type FeatureExtractionPipeline = (
    texts: string[],
    options: {pooling: 'mean' | 'cls'; normalize: boolean}
) => Promise<{tolist(): number[][]}>;

type TransformersModule = {
    pipeline(task: 'feature-extraction', model: string): Promise<FeatureExtractionPipeline>;
};

export class HuggingFaceEmbedder implements Embedder {
    public readonly dimension: number;
    private readonly documentPrefix: string;
    private readonly queryPrefix: string;
    private extractor: FeatureExtractionPipeline | null = null;
    private loadPromise: Promise<FeatureExtractionPipeline> | null = null;

    public constructor(private readonly options: HuggingFaceEmbedderOptions) {
        this.dimension = options.dimension;
        const defaults = DEFAULT_PREFIXES_BY_MODEL[options.model] ?? {document: '', query: ''};
        this.documentPrefix = options.documentPrefix ?? defaults.document;
        this.queryPrefix = options.queryPrefix ?? defaults.query;
    }

    private async loadExtractor(): Promise<FeatureExtractionPipeline> {
        if (this.extractor !== null) {
            return this.extractor;
        }

        if (this.loadPromise === null) {
            this.loadPromise = this.importAndLoad();
        }

        this.extractor = await this.loadPromise;
        return this.extractor;
    }

    private async importAndLoad(): Promise<FeatureExtractionPipeline> {
        let mod: TransformersModule;

        // Indirect specifier so TS doesn't try to resolve the module type at
        // build time — keeps @huggingface/transformers a true optional dep:
        // users on voyage/ollama/none never have to install onnxruntime.
        const moduleSpec = '@huggingface/transformers';

        try {
            mod = (await import(moduleSpec)) as TransformersModule;
        } catch (error) {
            throw new VectorError(
                'HuggingFace embedder requires @huggingface/transformers. Install with `npm install @huggingface/transformers`.',
                error
            );
        }

        try {
            return await mod.pipeline('feature-extraction', this.options.model);
        } catch (error) {
            throw new VectorError(
                `HuggingFace model load failed (${this.options.model}): ${error instanceof Error ? error.message : String(error)}`,
                error
            );
        }
    }

    public async embed(texts: string[], inputType: EmbedderInputType): Promise<number[][]> {
        if (texts.length === 0) {
            return [];
        }

        const extractor = await this.loadExtractor();
        const prefix = inputType === 'document' ? this.documentPrefix : this.queryPrefix;
        const inputs = prefix.length === 0 ? texts : texts.map((t) => `${prefix}${t}`);

        let vectors: number[][];

        try {
            const tensor = await extractor(inputs, {pooling: 'mean', normalize: true});
            vectors = tensor.tolist();
        } catch (error) {
            throw new VectorError(
                `HuggingFace inference error: ${error instanceof Error ? error.message : String(error)}`,
                error
            );
        }

        if (!Array.isArray(vectors) || vectors.length !== texts.length) {
            throw new VectorError(`HuggingFace returned ${vectors.length} embeddings for ${texts.length} inputs`);
        }

        return vectors;
    }

    public async embedOne(text: string, inputType: EmbedderInputType): Promise<number[]> {
        const [vector] = await this.embed([text], inputType);

        if (!vector) {
            throw new VectorError('HuggingFace returned no embedding');
        }

        return vector;
    }
}