export interface BenchNote {
    path: string;
    title: string;
    body: string;
    tags?: readonly string[];
}

export interface BenchQuery {
    id: string;
    query: string;
    relevant: readonly string[];
}

// Skeleton dataset: small, hand-built, designed so fulltext can find most hits
// without embeddings. Extend NOTES and QUERIES to grow the harness — the
// metric helpers and runner don't need to change.
export const NOTES: readonly BenchNote[] = [
    {
        path: 'Memory/decisions/qdrant-as-vector-store.md',
        title: 'Qdrant as vector store',
        body: 'We pick Qdrant for the vector database because it supports HNSW, filters by payload, and runs in a single Docker container. Alternatives considered: Chroma, Weaviate, LanceDB.',
        tags: ['decision', 'qdrant', 'vector']
    },
    {
        path: 'Memory/bugs/qdrant-timeout-during-reindex.md',
        title: 'Qdrant timeout during reindex',
        body: 'When the embedder is slow, the Qdrant client times out at 30 s. Workaround: stream batches of 100 and bump timeout to 90 s.',
        tags: ['bug', 'qdrant']
    },
    {
        path: 'Memory/code-patterns/reciprocal-rank-fusion.md',
        title: 'Reciprocal rank fusion',
        body: 'RRF combines title hits, semantic hits, and full-text hits using 1 over (k + rank). k=60 is the conventional choice. See Fusion.ts.',
        tags: ['pattern', 'search']
    },
    {
        path: 'Memory/architecture/web-ui-graph-rendering.md',
        title: 'Web UI graph rendering',
        body: 'The graph view uses Cytoscape with a community-level LOD: edges hide when zoomed out. Hit testing uses a quadtree so mousemove stays cheap on large vaults.',
        tags: ['arch', 'web', 'graph']
    },
    {
        path: 'Memory/architecture/chat-storage.md',
        title: 'Chat storage layout',
        body: 'Chats live in .synaipse-chats/ outside the vault. ChatRepo handles disk IO, ChatStore handles serialize/parse with gray-matter frontmatter.',
        tags: ['arch', 'chat']
    },
    {
        path: 'Memory/decisions/no-react-no-tsx.md',
        title: 'Drop React and TSX from the web package',
        body: 'We move away from React in @synaipse/web. Reasons: bundle size, build complexity. Replacement framework TBD.',
        tags: ['decision', 'web']
    },
    {
        path: 'Memory/research/ollama-local-embeddings.md',
        title: 'Ollama for local embeddings',
        body: 'Ollama can serve nomic-embed-text locally over HTTP. Pull once with ollama pull, then call /api/embeddings. No API key needed.',
        tags: ['research', 'ollama', 'embeddings']
    },
    {
        path: 'Memory/code-patterns/hash-cache-touch.md',
        title: 'Hash cache touch-access pattern',
        body: 'Every read or search bumps lastAccessed on the note. This feeds the stale detector — notes neither written nor read for 90 days surface as candidates for archive.',
        tags: ['pattern', 'cache']
    }
];

export const QUERIES: readonly BenchQuery[] = [
    {
        id: 'q1-qdrant',
        query: 'qdrant',
        relevant: [
            'Memory/decisions/qdrant-as-vector-store.md',
            'Memory/bugs/qdrant-timeout-during-reindex.md'
        ]
    },
    {
        id: 'q2-rrf',
        query: 'reciprocal rank fusion',
        relevant: ['Memory/code-patterns/reciprocal-rank-fusion.md']
    },
    {
        id: 'q3-graph',
        query: 'graph rendering cytoscape',
        relevant: ['Memory/architecture/web-ui-graph-rendering.md']
    },
    {
        id: 'q4-ollama',
        query: 'ollama embeddings',
        relevant: ['Memory/research/ollama-local-embeddings.md']
    }
];