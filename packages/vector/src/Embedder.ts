export type EmbedderInputType = 'document' | 'query';

export interface Embedder {
    readonly dimension: number;
    embed(texts: string[], inputType: EmbedderInputType): Promise<number[][]>;
    embedOne(text: string, inputType: EmbedderInputType): Promise<number[]>;
}