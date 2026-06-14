import type {Chunk, Note} from '@synaipse/core';

export interface ChunkOptions {
    targetChars: number;
    overlapChars: number;
    /** Hard upper bound — chunks larger than this are sliced even if they were a single paragraph. Keeps us under the embedder's context window. */
    hardCapChars: number;
}

export const CHUNK_DEFAULTS: ChunkOptions = {
    targetChars: 1200,
    overlapChars: 150,
    hardCapChars: 4000
};

const splitParagraphs = (content: string): string[] => {
    return content
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
};

export const chunkNote = (note: Note, opts: Partial<ChunkOptions> = {}): Chunk[] => {
    const merged: ChunkOptions = {...CHUNK_DEFAULTS, ...opts};
    return chunkNoteWith(note, merged);
};

const chunkNoteWith = (note: Note, opts: ChunkOptions): Chunk[] => {
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

    return enforceHardCap(chunks, opts);
};

const enforceHardCap = (chunks: Chunk[], opts: ChunkOptions): Chunk[] => {
    const out: Chunk[] = [];
    let outIdx = 0;

    for (const chunk of chunks) {
        if (chunk.text.length <= opts.hardCapChars) {
            out.push({...chunk, id: `${chunk.noteId}::${outIdx}`, index: outIdx});
            outIdx += 1;
            continue;
        }

        let pos = 0;
        const step = Math.max(1, opts.hardCapChars - opts.overlapChars);

        while (pos < chunk.text.length) {
            const piece = chunk.text.slice(pos, pos + opts.hardCapChars).trim();

            if (piece.length > 0) {
                out.push({
                    id: `${chunk.noteId}::${outIdx}`,
                    noteId: chunk.noteId,
                    path: chunk.path,
                    text: piece,
                    index: outIdx
                });
                outIdx += 1;
            }

            pos += step;
        }
    }

    return out;
};