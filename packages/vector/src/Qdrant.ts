import {QdrantClient} from '@qdrant/js-client-rest';
import {VectorError} from '@synaipse/core';
import type {Chunk, NoteId, SearchHit} from '@synaipse/core';

export interface QdrantStoreOptions {
    url: string;
    apiKey?: string;
    collection: string;
    dimension: number;
}

interface ChunkPayload {
    noteId: NoteId;
    path: string;
    text: string;
    index: number;
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

export class QdrantStore {
    private readonly client: QdrantClient;
    private ready = false;

    public constructor(private readonly options: QdrantStoreOptions) {
        this.client = new QdrantClient({
            url: options.url,
            ...(options.apiKey !== undefined ? {apiKey: options.apiKey} : {})
        });
    }

    public async ensureCollection(): Promise<void> {
        if (this.ready) {
            return;
        }

        const collections = await this.client.getCollections();
        const exists = collections.collections.some((c) => c.name === this.options.collection);

        if (!exists) {
            await this.client.createCollection(this.options.collection, {
                vectors: {size: this.options.dimension, distance: 'Cosine'}
            });

            await this.client.createPayloadIndex(this.options.collection, {
                field_name: 'noteId',
                field_schema: 'keyword'
            });
        }

        this.ready = true;
    }

    public async upsert(chunks: Chunk[], vectors: number[][]): Promise<void> {
        if (chunks.length === 0) {
            return;
        }

        if (chunks.length !== vectors.length) {
            throw new VectorError(`Chunk/vector count mismatch: ${chunks.length} vs ${vectors.length}`);
        }

        await this.ensureCollection();

        await this.client.upsert(this.options.collection, {
            wait: true,
            points: chunks.map((chunk, i) => ({
                id: chunk.id,
                vector: vectors[i]!,
                payload: {
                    noteId: chunk.noteId,
                    path: chunk.path,
                    text: chunk.text,
                    index: chunk.index
                } satisfies ChunkPayload
            }))
        });
    }

    public async deleteByNote(noteId: NoteId): Promise<void> {
        await this.deleteByNotes([noteId]);
    }

    public async deleteByNotes(noteIds: NoteId[]): Promise<void> {
        if (noteIds.length === 0) {
            return;
        }

        await this.ensureCollection();

        await this.client.delete(this.options.collection, {
            wait: true,
            filter: {
                must: [{key: 'noteId', match: {any: noteIds}}]
            }
        });
    }

    public async search(vector: number[], limit: number): Promise<SearchHit[]> {
        await this.ensureCollection();

        const results = await this.client.search(this.options.collection, {
            vector,
            limit,
            with_payload: true
        });

        const hits: SearchHit[] = [];

        for (const point of results) {
            if (!isChunkPayload(point.payload)) {
                continue;
            }

            hits.push({
                noteId: point.payload.noteId,
                path: point.payload.path,
                title: point.payload.noteId,
                score: point.score,
                snippet: point.payload.text.slice(0, 240),
                chunkId: String(point.id)
            });
        }

        return hits;
    }
}