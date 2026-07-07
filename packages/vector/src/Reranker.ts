import {VectorError} from '@synaipse/core';

/**
 * Cross-encoder reranker. Unlike the bi-encoder Embedder, this scores a
 * (query, passage) pair jointly and returns a single relevance score —
 * more precise than cosine-similarity between two independently-computed
 * vectors, at the cost of running one forward pass per candidate. In
 * practice we use it to re-order the top-N hits from RRF fusion.
 */
export interface Reranker {
    readonly model: string;

    /**
     * Score how relevant each passage is to the query. Higher = more
     * relevant. The returned array has the same length + order as
     * `passages`. Callers pair the scores back with their original hits
     * and reorder.
     */
    score(query: string, passages: string[]): Promise<number[]>;
}

export interface HuggingFaceRerankerOptions {
    /** Model repo, e.g. "Xenova/ms-marco-MiniLM-L-6-v2". */
    model: string;
    /** Cap on tokens per pair. Cross-encoders truncate long docs anyway;
     *  smaller = faster. Default 512 mirrors the model's own limit. */
    maxLength?: number;
}

type Tokenizer = ((
    texts: string[],
    options: {text_pair: string[]; padding: boolean; truncation: boolean; max_length?: number; return_tensor?: boolean}
) => Promise<{
    input_ids: unknown;
    attention_mask: unknown;
    token_type_ids?: unknown;
}>) & {model_max_length?: number};

type SequenceClassificationModel = (inputs: {
    input_ids: unknown;
    attention_mask: unknown;
    token_type_ids?: unknown;
}) => Promise<{logits: {data: Float32Array | number[]; dims: number[]}}>;

type TransformersModule = {
    AutoTokenizer: {
        from_pretrained(model: string): Promise<Tokenizer>;
    };
    AutoModelForSequenceClassification: {
        from_pretrained(model: string): Promise<SequenceClassificationModel>;
    };
};

/**
 * HuggingFace-flavoured cross-encoder — runs a `AutoModelForSequenceClassification`
 * over the raw pair `(query, passage)` and returns the raw logit. For
 * MS-MARCO cross-encoders this logit IS the relevance score; no
 * sigmoid/softmax is needed for ranking (the ordering is what matters).
 *
 * The `@huggingface/transformers` package is loaded via an indirect
 * import specifier so it remains an *optional* peer dep — users on the
 * voyage/ollama/none path can ignore it entirely (300 MB ONNX runtime).
 */
export class HuggingFaceReranker implements Reranker {
    public readonly model: string;
    private readonly maxLength: number;
    private tokenizer: Tokenizer | null = null;
    private modelFn: SequenceClassificationModel | null = null;
    private loadPromise: Promise<{tokenizer: Tokenizer; model: SequenceClassificationModel}> | null = null;

    public constructor(options: HuggingFaceRerankerOptions) {
        this.model = options.model;
        this.maxLength = options.maxLength ?? 512;
    }

    private async load(): Promise<{tokenizer: Tokenizer; model: SequenceClassificationModel}> {
        if (this.tokenizer !== null && this.modelFn !== null) {
            return {tokenizer: this.tokenizer, model: this.modelFn};
        }

        if (this.loadPromise === null) {
            this.loadPromise = this.importAndLoad();
        }

        const loaded = await this.loadPromise;
        this.tokenizer = loaded.tokenizer;
        this.modelFn = loaded.model;
        return loaded;
    }

    private async importAndLoad(): Promise<{tokenizer: Tokenizer; model: SequenceClassificationModel}> {
        let mod: TransformersModule;

        // Indirect specifier — see HuggingFaceEmbedder for the same
        // trick. Keeps the ONNX runtime an optional dep.
        const moduleSpec = '@huggingface/transformers';

        try {
            mod = (await import(moduleSpec)) as TransformersModule;
        } catch (error) {
            throw new VectorError(
                'HuggingFace reranker requires @huggingface/transformers. Install with `npm install @huggingface/transformers`.',
                error
            );
        }

        try {
            const [tokenizer, model] = await Promise.all([
                mod.AutoTokenizer.from_pretrained(this.model),
                mod.AutoModelForSequenceClassification.from_pretrained(this.model)
            ]);
            return {tokenizer, model};
        } catch (error) {
            throw new VectorError(
                `HuggingFace reranker load failed (${this.model}): ${error instanceof Error ? error.message : String(error)}`,
                error
            );
        }
    }

    public async score(query: string, passages: string[]): Promise<number[]> {
        if (passages.length === 0) {
            return [];
        }

        const {tokenizer, model} = await this.load();

        // Broadcast query across every passage — the tokenizer's
        // `text_pair` argument encodes each (query, passage) as one
        // sequence, so we get N pair-encodings in one batched call.
        const queries = passages.map(() => query);

        let logits: Float32Array | number[];
        let dims: number[];

        try {
            const inputs = await tokenizer(queries, {
                text_pair: passages,
                padding: true,
                truncation: true,
                max_length: this.maxLength
            });
            const output = await model(inputs);
            logits = output.logits.data;
            dims = output.logits.dims;
        } catch (error) {
            throw new VectorError(
                `HuggingFace reranker inference error: ${error instanceof Error ? error.message : String(error)}`,
                error
            );
        }

        // MS-MARCO cross-encoders emit a single logit per pair, so the
        // logits tensor shape is [batch, 1]. Grab the first column.
        // If a model surfaces multi-class output instead we take the
        // first slot deterministically — mis-configured user problem.
        const classes = dims.length >= 2 ? dims[1] ?? 1 : 1;
        const arr = Array.isArray(logits) ? logits : Array.from(logits);
        const scores: number[] = [];
        for (let i = 0; i < passages.length; i++) {
            const score = arr[i * classes];
            if (typeof score !== 'number') {
                throw new VectorError(`Reranker returned non-numeric score at index ${i}`);
            }
            scores.push(score);
        }

        return scores;
    }
}