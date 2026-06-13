import {VectorError} from '@synaipse/core';
import type {Embedder, EmbedderInputType} from './Embedder.js';

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

export type VoyageInputType = EmbedderInputType;

export type VoyageRetryReason = number | 'network';

export interface VoyageRetryInfo {
    attempt: number;
    reason: VoyageRetryReason;
    waitMs: number;
    error?: unknown;
}

export interface VoyageRetryOptions {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: (info: VoyageRetryInfo) => void;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
}

export interface VoyageEmbedderOptions {
    apiKey: string;
    model: string;
    dimension: number;
    retry?: VoyageRetryOptions;
}

interface VoyageResponse {
    data: Array<{embedding: number[]; index: number}>;
    model: string;
    usage: {total_tokens: number};
}

interface ResolvedRetry {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    onRetry?: (info: VoyageRetryInfo) => void;
    sleep: (ms: number) => Promise<void>;
    random: () => number;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

const resolveRetry = (opts: VoyageRetryOptions | undefined): ResolvedRetry => ({
    maxRetries: opts?.maxRetries ?? 5,
    baseDelayMs: opts?.baseDelayMs ?? 500,
    maxDelayMs: opts?.maxDelayMs ?? 30_000,
    sleep: opts?.sleep ?? DEFAULT_SLEEP,
    random: opts?.random ?? Math.random,
    ...(opts?.onRetry ? {onRetry: opts.onRetry} : {})
});

const isRetryableStatus = (status: number): boolean =>
    status === 429 || status === 408 || (status >= 500 && status < 600);

export const parseRetryAfter = (header: string | null, now: number = Date.now()): number | null => {
    if (header === null || header === '') {
        return null;
    }

    const seconds = Number.parseFloat(header);

    if (Number.isFinite(seconds) && !Number.isNaN(seconds)) {
        return Math.max(0, seconds * 1000);
    }

    const date = Date.parse(header);

    if (!Number.isNaN(date)) {
        return Math.max(0, date - now);
    }

    return null;
};

const backoffWait = (attempt: number, retry: ResolvedRetry): number => {
    const exp = retry.baseDelayMs * Math.pow(2, attempt);
    const jitter = retry.random() * retry.baseDelayMs;
    return Math.min(retry.maxDelayMs, exp + jitter);
};

export class VoyageEmbedder implements Embedder {
    public readonly dimension: number;
    private readonly retry: ResolvedRetry;

    public constructor(private readonly options: VoyageEmbedderOptions) {
        this.dimension = options.dimension;
        this.retry = resolveRetry(options.retry);
    }

    public async embed(texts: string[], inputType: VoyageInputType): Promise<number[][]> {
        if (texts.length === 0) {
            return [];
        }

        return this.callWithRetry(texts, inputType);
    }

    public async embedOne(text: string, inputType: VoyageInputType): Promise<number[]> {
        const [vector] = await this.embed([text], inputType);

        if (!vector) {
            throw new VectorError('Voyage returned no embedding');
        }

        return vector;
    }

    private async callWithRetry(texts: string[], inputType: VoyageInputType): Promise<number[][]> {
        const maxAttempts = this.retry.maxRetries + 1;

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const result = await this.tryOnce(texts, inputType);

            if (result.kind === 'ok') {
                return result.vectors;
            }

            const isLast = attempt === maxAttempts - 1;

            if (result.kind === 'permanent' || isLast) {
                throw new VectorError(result.message, result.error);
            }

            const wait = result.retryAfterMs ?? backoffWait(attempt, this.retry);

            this.retry.onRetry?.({
                attempt: attempt + 1,
                reason: result.reason,
                waitMs: wait,
                error: result.error
            });

            await this.retry.sleep(wait);
        }

        throw new VectorError('Voyage retry loop exhausted unexpectedly');
    }

    private async tryOnce(
        texts: string[],
        inputType: VoyageInputType
    ): Promise<
        | {kind: 'ok'; vectors: number[][]}
        | {kind: 'retryable'; reason: VoyageRetryReason; retryAfterMs: number | null; message: string; error?: unknown}
        | {kind: 'permanent'; message: string; error?: unknown}
    > {
        let response: Response;

        try {
            response = await fetch(VOYAGE_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.options.apiKey}`
                },
                body: JSON.stringify({
                    input: texts,
                    model: this.options.model,
                    input_type: inputType
                })
            });
        } catch (error) {
            return {
                kind: 'retryable',
                reason: 'network',
                retryAfterMs: null,
                message: `Voyage network error: ${error instanceof Error ? error.message : String(error)}`,
                error
            };
        }

        if (response.ok) {
            const payload = (await response.json()) as VoyageResponse;
            const sorted = [...payload.data].sort((a, b) => a.index - b.index);
            return {kind: 'ok', vectors: sorted.map((d) => d.embedding)};
        }

        const body = await response.text();
        const message = `Voyage API error ${response.status}: ${body}`;

        if (isRetryableStatus(response.status)) {
            return {
                kind: 'retryable',
                reason: response.status,
                retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
                message
            };
        }

        return {kind: 'permanent', message};
    }
}