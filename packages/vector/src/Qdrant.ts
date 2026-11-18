import {createHash} from 'node:crypto';
import {QdrantClient} from '@qdrant/js-client-rest';
import {VectorError} from '@synaipse/core';
import type {Chunk, NoteId, SearchHit} from '@synaipse/core';
import type {VectorStore} from './VectorStore.js';

export interface QdrantRetryInfo {
    attempt: number;
    error: unknown;
    waitMs: number;
}

export interface QdrantRetryOptions {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: (info: QdrantRetryInfo) => void;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
}

export interface QdrantStoreOptions {
    url: string;
    apiKey?: string;
    collection: string;
    dimension: number;
    retry?: QdrantRetryOptions;
}

interface ResolvedRetry {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    onRetry?: (info: QdrantRetryInfo) => void;
    sleep: (ms: number) => Promise<void>;
    random: () => number;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

const resolveRetry = (opts: QdrantRetryOptions | undefined): ResolvedRetry => ({
    maxRetries: opts?.maxRetries ?? 5,
    baseDelayMs: opts?.baseDelayMs ?? 300,
    maxDelayMs: opts?.maxDelayMs ?? 5_000,
    sleep: opts?.sleep ?? DEFAULT_SLEEP,
    random: opts?.random ?? Math.random,
    ...(opts?.onRetry ? {onRetry: opts.onRetry} : {})
});

// undici-level transient errors that warrant a retry. The real signal is
// usually buried under `TypeError: fetch failed` — walk `.cause` to find it.
// Typical trigger: a slow embedder (HF on CPU, large batch) leaves the
// keep-alive socket idle long enough for Qdrant to close it; the next call
// then sees "other side closed" or EPIPE on a stale pooled connection.
const RETRYABLE_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
    'EAI_AGAIN'
]);

export const isRetryableNetworkError = (error: unknown): boolean => {
    let cur: unknown = error;

    for (let depth = 0; depth < 5 && cur !== undefined; depth += 1) {
        if (!(cur instanceof Error)) {
            return false;
        }

        const code = (cur as Error & {code?: unknown}).code;
        const codeStr = typeof code === 'string' ? code : '';

        if (
            cur.name === 'SocketError'
            || RETRYABLE_CODES.has(codeStr)
            || codeStr.startsWith('UND_ERR_')
        ) {
            return true;
        }

        cur = (cur as Error & {cause?: unknown}).cause;
    }

    return false;
};

interface ChunkPayload {
    noteId: NoteId;
    path: string;
    text: string;
    index: number;
    chunkId: string;
    hash?: string;
}

const isChunkPayload = (value: unknown): value is ChunkPayload => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const record = value as Record<string, unknown>;

    return typeof record.noteId === 'string'
        && typeof record.path === 'string'
        && typeof record.text === 'string'
        && typeof record.index === 'number';
};

/**
 * Qdrant rejects free-form string point IDs — only unsigned ints and UUIDs.
 * SHA-1 → first 32 hex chars → UUID format. Stable and idempotent for the
 * same input string, so re-indexing is still a no-op.
 */
const toPointId = (chunkId: string): string => {
    const hex = createHash('sha1').update(chunkId).digest('hex').slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/**
 * Some user content (especially crawled HTML/markdown) carries lone UTF-16
 * surrogates and other invalid sequences that the Qdrant server's JSON parser
 * rejects with "lone leading surrogate in hex escape". Replace orphan
 * surrogates with U+FFFD and drop NULs.
 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const sanitiseText = (text: string): string => {
    return text.replace(LONE_SURROGATE_RE, '�').replaceAll('\0', '');
};

/** Notes per stale-chunk delete request (one nested filter each). */
const STALE_DELETE_GROUP = 256;

/** Notes per hash-lookup scroll filter. */
const HASH_LOOKUP_GROUP = 256;

/** Search needs only these fields; the stored hash stays on the server. */
const SEARCH_PAYLOAD = ['noteId', 'path', 'text', 'index', 'chunkId'];

export class QdrantStore implements VectorStore {
    private readonly client: QdrantClient;
    private readonly retry: ResolvedRetry;
    private ready = false;
    /** Cleared once the server turns out not to support the Query API. */
    private queryApi = true;

    public constructor(private readonly options: QdrantStoreOptions) {
        this.client = new QdrantClient({
            url: options.url,
            ...(options.apiKey !== undefined ? {apiKey: options.apiKey} : {})
        });
        this.retry = resolveRetry(options.retry);
    }

    private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
        let attempt = 0;

        while (true) {
            try {
                return await fn();
            } catch (error) {
                if (attempt >= this.retry.maxRetries || !isRetryableNetworkError(error)) {
                    throw error;
                }

                attempt += 1;
                const jitter = 0.5 + this.retry.random() * 0.5;
                const waitMs = Math.min(
                    this.retry.maxDelayMs,
                    Math.floor(this.retry.baseDelayMs * 2 ** (attempt - 1) * jitter)
                );

                this.retry.onRetry?.({attempt, error, waitMs});
                await this.retry.sleep(waitMs);
            }
        }
    }

    public async ensureCollection(): Promise<void> {
        if (this.ready) {
            return;
        }

        const collections = await this.withRetry(() => this.client.getCollections());
        const exists = collections.collections.some((c) => c.name === this.options.collection);

        if (!exists) {
            await this.withRetry(() => this.client.createCollection(this.options.collection, {
                vectors: {size: this.options.dimension, distance: 'Cosine'}
            }));

            await this.withRetry(() => this.client.createPayloadIndex(this.options.collection, {
                field_name: 'noteId',
                field_schema: 'keyword'
            }));
        } else {
            await this.assertDimension();
        }

        this.ready = true;
    }

    /**
     * Refuse to work against a collection built for a different embedder
     * dimension. Without this check a model switch either fails on every
     * upsert with an opaque 400 or — same dimension, different model —
     * silently mixes two vector spaces.
     */
    private async assertDimension(): Promise<void> {
        const info = await this.withRetry(() => this.client.getCollection(this.options.collection));
        const vectors = (info.config?.params as {vectors?: unknown} | undefined)?.vectors;
        const size = typeof vectors === 'object' && vectors !== null && typeof (vectors as {size?: unknown}).size === 'number'
            ? (vectors as {size: number}).size
            : null;

        if (size !== null && size !== this.options.dimension) {
            throw new VectorError(
                `Qdrant collection "${this.options.collection}" has vector size ${size}, ` +
                `but the configured embedder produces ${this.options.dimension}. ` +
                `Use a different QDRANT_COLLECTION for this model (or delete the collection to rebuild it).`
            );
        }
    }

    public async upsert(chunks: Chunk[], vectors: number[][]): Promise<void> {
        if (chunks.length === 0) {
            return;
        }

        if (chunks.length !== vectors.length) {
            throw new VectorError(`Chunk/vector count mismatch: ${chunks.length} vs ${vectors.length}`);
        }

        await this.ensureCollection();

        await this.withRetry(() => this.client.upsert(this.options.collection, {
            wait: true,
            points: chunks.map((chunk, i) => ({
                id: toPointId(chunk.id),
                vector: vectors[i]!,
                payload: {
                    noteId: chunk.noteId,
                    path: chunk.path,
                    text: sanitiseText(chunk.text),
                    index: chunk.index,
                    chunkId: chunk.id,
                    ...(chunk.hash !== undefined ? {hash: chunk.hash} : {})
                } satisfies ChunkPayload
            }))
        }));
    }

    public async deleteByNote(noteId: NoteId): Promise<void> {
        await this.deleteByNotes([noteId]);
    }

    public async deleteByNotes(noteIds: NoteId[]): Promise<void> {
        if (noteIds.length === 0) {
            return;
        }

        await this.ensureCollection();

        await this.withRetry(() => this.client.delete(this.options.collection, {
            wait: true,
            filter: {
                must: [{key: 'noteId', match: {any: noteIds}}]
            }
        }));
    }

    public async deleteStaleChunks(keep: ReadonlyMap<NoteId, number>): Promise<void> {
        if (keep.size === 0) {
            return;
        }

        await this.ensureCollection();
        const entries = [...keep.entries()];

        for (let i = 0; i < entries.length; i += STALE_DELETE_GROUP) {
            const group = entries.slice(i, i + STALE_DELETE_GROUP);
            await this.withRetry(() => this.client.delete(this.options.collection, {
                wait: true,
                filter: {
                    should: group.map(([noteId, count]) => ({
                        must: [
                            {key: 'noteId', match: {value: noteId}},
                            ...(count > 0 ? [{key: 'index', range: {gte: count}}] : [])
                        ]
                    }))
                }
            }));
        }
    }

    /**
     * One hit per note, best chunk first (plan P4 / A4): the Query API
     * with `group_by: noteId` replaces the deprecated `search`, which
     * returned several chunks of the same note and crowded out others.
     * Servers without the Query API (< 1.10) fall back to `search` with
     * client-side de-duplication.
     */
    public async search(vector: number[], limit: number): Promise<SearchHit[]> {
        await this.ensureCollection();

        if (this.queryApi) {
            try {
                const result = await this.withRetry(() => this.client.queryGroups(this.options.collection, {
                    query: vector,
                    group_by: 'noteId',
                    group_size: 1,
                    limit,
                    with_payload: SEARCH_PAYLOAD
                }));

                return this.toHits(result.groups.flatMap((g) => g.hits.slice(0, 1)));
            } catch (error) {
                if (isRetryableNetworkError(error)) throw error;
                this.queryApi = false;
            }
        }

        const results = await this.withRetry(() => this.client.search(this.options.collection, {
            vector,
            limit: limit * 3,
            with_payload: SEARCH_PAYLOAD
        }));

        const seen = new Set<string>();
        return this.toHits(results).filter((hit) => {
            if (seen.has(hit.noteId)) return false;
            seen.add(hit.noteId);
            return true;
        }).slice(0, limit);
    }

    private toHits(points: ReadonlyArray<{score: number; payload?: Record<string, unknown> | null | undefined}>): SearchHit[] {
        const hits: SearchHit[] = [];

        for (const point of points) {
            if (!isChunkPayload(point.payload)) {
                continue;
            }

            hits.push({
                noteId: point.payload.noteId,
                path: point.payload.path,
                title: point.payload.noteId,
                score: point.score,
                snippet: point.payload.text.slice(0, 240),
                chunkId: point.payload.chunkId
            });
        }

        return hits;
    }

    public async chunkHashes(noteIds: readonly NoteId[]): Promise<Map<string, string>> {
        const out = new Map<string, string>();

        if (noteIds.length === 0) {
            return out;
        }

        await this.ensureCollection();

        for (let i = 0; i < noteIds.length; i += HASH_LOOKUP_GROUP) {
            const group = noteIds.slice(i, i + HASH_LOOKUP_GROUP);
            let offset: string | number | Record<string, unknown> | null | undefined;

            do {
                const page = await this.withRetry(() => this.client.scroll(this.options.collection, {
                    filter: {must: [{key: 'noteId', match: {any: [...group]}}]},
                    with_payload: ['chunkId', 'hash'],
                    with_vector: false,
                    limit: 1024,
                    ...(offset !== undefined && offset !== null ? {offset: offset as string | number} : {})
                }));

                for (const point of page.points) {
                    const payload = point.payload as {chunkId?: unknown; hash?: unknown} | null | undefined;
                    if (typeof payload?.chunkId === 'string' && typeof payload.hash === 'string') {
                        out.set(payload.chunkId, payload.hash);
                    }
                }

                offset = page.next_page_offset;
            } while (offset !== undefined && offset !== null);
        }

        return out;
    }

    public async vectorsOf(chunkIds: readonly string[]): Promise<Map<string, number[]>> {
        const out = new Map<string, number[]>();

        if (chunkIds.length === 0) {
            return out;
        }

        await this.ensureCollection();
        const byPoint = new Map(chunkIds.map((id) => [toPointId(id), id]));
        const points = await this.withRetry(() => this.client.retrieve(this.options.collection, {
            ids: [...byPoint.keys()],
            with_payload: false,
            with_vector: true
        }));

        for (const point of points) {
            const chunkId = byPoint.get(String(point.id));
            if (chunkId !== undefined && Array.isArray(point.vector) && typeof point.vector[0] === 'number') {
                out.set(chunkId, point.vector as number[]);
            }
        }

        return out;
    }
}