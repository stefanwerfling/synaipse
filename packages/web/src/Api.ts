import type {Frontmatter, Graph, Note, SearchHit, SearchMode} from '@synaipse/core';

const json = async <T>(response: Response): Promise<T> => {
    if (!response.ok) {
        throw new Error(`API ${response.status}: ${await response.text()}`);
    }

    return response.json() as Promise<T>;
};

const noContent = async (response: Response): Promise<void> => {
    if (!response.ok) {
        throw new Error(`API ${response.status}: ${await response.text()}`);
    }
};

export interface WriteNoteInput {
    path: string;
    content: string;
    frontmatter?: Frontmatter;
}

export interface NoteSummary {
    id: string;
    title: string;
    tags: string[];
    mtime: number;
    aliases: string[];
}

export const api = {
    listNotes: async (): Promise<NoteSummary[]> => {
        return json(await fetch('/api/notes'));
    },
    getNote: async (id: string): Promise<Note> => {
        return json(await fetch(`/api/notes/${encodeURIComponent(id)}`));
    },
    writeNote: async (input: WriteNoteInput): Promise<Note> => {
        const response = await fetch(`/api/notes/${encodeURIComponent(input.path)}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(input)
        });
        return json(response);
    },
    deleteNote: async (id: string): Promise<void> => {
        await noContent(await fetch(`/api/notes/${encodeURIComponent(id)}`, {method: 'DELETE'}));
    },
    search: async (query: string, mode: SearchMode = 'hybrid', limit = 20): Promise<SearchHit[]> => {
        const url = new URL('/api/search', window.location.origin);
        url.searchParams.set('q', query);
        url.searchParams.set('mode', mode);
        url.searchParams.set('limit', String(limit));
        return json(await fetch(url));
    },
    getGraph: async (): Promise<Graph> => {
        return json(await fetch('/api/graph'));
    },
    getInfo: async (): Promise<{semanticEnabled: boolean; notesCount: number}> => {
        return json(await fetch('/api/info'));
    }
};