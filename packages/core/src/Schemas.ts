import {Vts, ExtractSchemaResultType} from 'vts';

export const FrontmatterSchema = Vts.object({
    title: Vts.optional(Vts.string()),
    tags: Vts.optional(Vts.array(Vts.string())),
    aliases: Vts.optional(Vts.array(Vts.string())),
    created: Vts.optional(Vts.string()),
    updated: Vts.optional(Vts.string())
});

export const NoteWriteInputSchema = Vts.object({
    path: Vts.string(),
    content: Vts.string(),
    frontmatter: Vts.optional(FrontmatterSchema)
});
export type NoteWriteInputSchemaT = ExtractSchemaResultType<typeof NoteWriteInputSchema>;

export const SearchModeSchema = Vts.or([
    Vts.equal('fulltext' as const),
    Vts.equal('semantic' as const),
    Vts.equal('hybrid' as const)
]);

export const SearchQuerySchema = Vts.object({
    query: Vts.string(),
    mode: Vts.optional(SearchModeSchema),
    limit: Vts.optional(Vts.number()),
    tags: Vts.optional(Vts.array(Vts.string())),
    paths: Vts.optional(Vts.array(Vts.string()))
});
export type SearchQuerySchemaT = ExtractSchemaResultType<typeof SearchQuerySchema>;

export const EmbeddingsProviderSchema = Vts.or([
    Vts.equal('voyage' as const),
    Vts.equal('ollama' as const),
    Vts.equal('none' as const)
]);

export const ConfigSchema = Vts.object({
    vaultPath: Vts.string(),
    indexCachePath: Vts.string(),
    embeddings: Vts.object({
        provider: EmbeddingsProviderSchema
    }),
    voyage: Vts.optional(Vts.object({
        apiKey: Vts.string(),
        model: Vts.string()
    })),
    ollama: Vts.optional(Vts.object({
        url: Vts.string(),
        model: Vts.string()
    })),
    qdrant: Vts.object({
        url: Vts.string(),
        apiKey: Vts.optional(Vts.string()),
        collection: Vts.string()
    }),
    server: Vts.object({
        name: Vts.string(),
        version: Vts.string()
    }),
    web: Vts.object({
        port: Vts.number()
    })
});
export type ConfigSchemaT = ExtractSchemaResultType<typeof ConfigSchema>;