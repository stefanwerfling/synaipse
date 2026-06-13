import {Vts, ExtractSchemaResultType, SchemaErrors} from 'vts';

export const NoteTypeSchema = Vts.or([
    Vts.equal('note' as const),
    Vts.equal('decision' as const),
    Vts.equal('bug' as const),
    Vts.equal('fact' as const),
    Vts.equal('concept' as const),
    Vts.equal('todo' as const),
    Vts.equal('question' as const)
]);

export const FrontmatterSchema = Vts.object(
    {
        title: Vts.optional(Vts.string()),
        tags: Vts.optional(Vts.array(Vts.string())),
        aliases: Vts.optional(Vts.array(Vts.string())),
        created: Vts.optional(Vts.string()),
        updated: Vts.optional(Vts.string()),
        type: Vts.optional(NoteTypeSchema),
        why: Vts.optional(Vts.string()),
        confidence: Vts.optional(Vts.number()),
        sources: Vts.optional(Vts.array(Vts.string())),
        supersedes: Vts.optional(Vts.array(Vts.string())),
        project: Vts.optional(Vts.string())
    },
    {objectSchema: {ignoreAdditionalItems: true}}
);

export interface FrontmatterValidationResult {
    ok: boolean;
    errors: string[];
}

const flattenSchemaErrors = (errors: SchemaErrors, prefix = ''): string[] => {
    const flat: string[] = [];

    for (const entry of errors) {
        if (typeof entry === 'string') {
            flat.push(prefix === '' ? entry : `${prefix}: ${entry}`);
            continue;
        }

        for (const [key, nested] of Object.entries(entry)) {
            const nextPrefix = prefix === '' ? key : `${prefix}.${key}`;
            flat.push(...flattenSchemaErrors(nested, nextPrefix));
        }
    }

    return flat;
};

export const validateFrontmatter = (value: unknown): FrontmatterValidationResult => {
    const schemaErrors: SchemaErrors = [];
    const messages: string[] = [];

    if (!FrontmatterSchema.validate(value, schemaErrors)) {
        messages.push(...flattenSchemaErrors(schemaErrors));
    }

    if (value !== null && typeof value === 'object') {
        const confidence = (value as Record<string, unknown>).confidence;

        if (confidence !== undefined && typeof confidence === 'number'
            && (confidence < 0 || confidence > 1)) {
            messages.push(`confidence: must be between 0 and 1, got ${confidence}`);
        }
    }

    return {ok: messages.length === 0, errors: messages};
};

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
    }),
    project: Vts.optional(Vts.object({
        name: Vts.string()
    }))
});
export type ConfigSchemaT = ExtractSchemaResultType<typeof ConfigSchema>;