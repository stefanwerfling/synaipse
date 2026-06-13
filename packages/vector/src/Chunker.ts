import type {Chunk, Note} from '@synaipse/core';

export interface ChunkOptions {
    targetChars: number;
    overlapChars: number;
}

export const CHUNK_DEFAULTS: ChunkOptions = {
    targetChars: 1200,
    overlapChars: 150
};

const splitParagraphs = (content: string): string[] => {
    return content
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
};

export const chunkNote = (note: Note, opts: ChunkOptions = CHUNK_DEFAULTS): Chunk[] => {
    const paragraphs = splitParagraphs(note.content);

    if (paragraphs.length === 0) {
        return [];
    }

    const chunks: Chunk[] = [];
    let buffer = '';
    let index = 0;

    const flush = (): void => {
        const text = buffer.trim();

        if (text.length === 0) {
            return;
        }

        chunks.push({
            id: `${note.id}::${index}`,
            noteId: note.id,
            path: note.path,
            text,
            index
        });

        index += 1;
    };

    for (const para of paragraphs) {
        if (buffer.length === 0) {
            buffer = para;
            continue;
        }

        if (buffer.length + para.length + 2 <= opts.targetChars) {
            buffer = `${buffer}\n\n${para}`;
            continue;
        }

        flush();
        const tail = buffer.slice(Math.max(0, buffer.length - opts.overlapChars));
        buffer = `${tail}\n\n${para}`;
    }

    flush();

    return chunks;
};