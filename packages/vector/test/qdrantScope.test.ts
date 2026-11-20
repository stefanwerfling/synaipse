import {describe, expect, it} from 'vitest';
import {QdrantStore, scopeToFilter} from '../src/Qdrant.js';

describe('scopeToFilter', () => {
    it('pushes folder includes and folder excludes to Qdrant', () => {
        expect(scopeToFilter({include: ['Memory/p/'], exclude: ['Clipped/']})).toEqual({
            filter: {must: [{key: 'dirs', match: {any: ['Memory/p/']}}], must_not: [{key: 'dirs', match: {any: ['Clipped/']}}]},
            exact: true
        });
    });

    it('marks prefixes inside a folder name as inexact', () => {
        const pushed = scopeToFilter({include: ['Memory/dec'], exclude: ['Memory/tmp-']});
        expect(pushed.filter).toEqual({must: [{key: 'dirs', match: {any: ['Memory/']}}]});
        expect(pushed.exact).toBe(false);
    });

    it('has nothing to push for an unscoped search', () => {
        expect(scopeToFilter(undefined)).toEqual({filter: null, exact: true});
        expect(scopeToFilter({include: ['root']}).filter).toBeNull();
    });
});

const point = (noteId: string, score: number) => ({
    score,
    payload: {noteId, path: noteId, text: noteId, index: 0, chunkId: `${noteId}::0`}
});

/** QdrantStore with its client replaced by a recorder. */
const storeWith = (missingDirs: number) => {
    const calls: Array<{method: string; args: Record<string, unknown>}> = [];
    const all = [point('Memory/a/1.md', 0.9), point('Other/2.md', 0.8), point('Memory/a/3.md', 0.7)];
    const client = {
        getCollections: async () => ({collections: [{name: 'c'}]}),
        getCollection: async () => ({config: {params: {vectors: {size: 3}}}}),
        createPayloadIndex: async () => ({}),
        count: async () => ({count: missingDirs}),
        scroll: async () => ({points: []}),
        setPayload: async () => ({}),
        retrieve: async (_c: string, args: {ids: string[]}) => args.ids.map((id) => ({id})),
        queryBatch: async (_c: string, args: {searches: Array<Record<string, unknown>>}) => {
            calls.push({method: 'queryBatch', args});
            return args.searches.map((search) => {
                const filter = search.filter as {must?: unknown[]} | undefined;
                const hits = filter?.must === undefined ? all : all.filter((p) => p.payload.noteId.startsWith('Memory/a/'));
                return {points: hits.slice(0, search.limit as number)};
            });
        },
        queryGroups: async (_c: string, args: Record<string, unknown>) => {
            calls.push({method: 'queryGroups', args});
            const hits = args.filter === undefined ? all : all.filter((p) => p.payload.noteId.startsWith('Memory/a/'));
            return {groups: hits.slice(0, args.limit as number).map((h) => ({hits: [h]}))};
        }
    };
    const store = new QdrantStore({url: 'http://x', collection: 'c', dimension: 3});
    (store as unknown as {client: unknown}).client = client;
    return {store, calls};
};

describe('QdrantStore.search with a scope', () => {
    it('filters in Qdrant once every point has dirs', async () => {
        const {store, calls} = storeWith(0);
        const hits = await store.search([1, 0, 0], 2, {include: ['Memory/a/']});
        expect(hits.map((h) => h.noteId)).toEqual(['Memory/a/1.md', 'Memory/a/3.md']);
        expect(calls[0]?.args.filter).toEqual({must: [{key: 'dirs', match: {any: ['Memory/a/']}}]});
        expect(calls[0]?.args.limit).toBe(2);
    });

    it('over-fetches and filters client-side while old points are being tagged', async () => {
        const {store, calls} = storeWith(5);
        const hits = await store.search([1, 0, 0], 2, {include: ['Memory/a/']});
        expect(hits.map((h) => h.noteId)).toEqual(['Memory/a/1.md', 'Memory/a/3.md']);
        expect(calls[0]?.args.filter).toBeUndefined();
        expect(calls[0]?.args.limit).toBe(12);
    });
});

describe('QdrantStore.similarToChunks with a scope (P4 A4)', () => {
    it('keeps excluding the note itself and adds the folder filter', async () => {
        const {store, calls} = storeWith(0);
        const out = await store.similarToChunks(['Memory/a/9.md::0'], 2, {include: ['Memory/a/']});
        const search = (calls[0]?.args.searches as Array<Record<string, unknown>>)[0];
        expect(search?.filter).toEqual({
            must: [{key: 'dirs', match: {any: ['Memory/a/']}}],
            must_not: [{key: 'noteId', match: {value: 'Memory/a/9.md'}}]
        });
        expect(out.get('Memory/a/9.md::0')?.map((h) => h.noteId)).toEqual(['Memory/a/1.md', 'Memory/a/3.md']);
    });

    it('filters client-side while old points lack dirs', async () => {
        const {store, calls} = storeWith(5);
        const out = await store.similarToChunks(['Memory/a/9.md::0'], 2, {include: ['Memory/a/']});
        const search = (calls[0]?.args.searches as Array<Record<string, unknown>>)[0];
        expect(search?.filter).toEqual({must_not: [{key: 'noteId', match: {value: 'Memory/a/9.md'}}]});
        expect(search?.limit).toBe(24);
        expect(out.get('Memory/a/9.md::0')?.map((h) => h.noteId)).toEqual(['Memory/a/1.md', 'Memory/a/3.md']);
    });

    it('unscoped stays as before', async () => {
        const {store, calls} = storeWith(0);
        await store.similarToChunks(['Memory/a/9.md::0'], 2);
        const search = (calls[0]?.args.searches as Array<Record<string, unknown>>)[0];
        expect(search?.filter).toEqual({must_not: [{key: 'noteId', match: {value: 'Memory/a/9.md'}}]});
        expect(search?.limit).toBe(6);
    });
});
