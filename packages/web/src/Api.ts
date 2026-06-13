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
    getInfo: async (): Promise<{semanticEnabled: boolean; notesCount: number; project: string | null; historyEnabled: boolean}> => {
        return json(await fetch('/api/info'));
    },
    noteHistory: async (id: string, limit = 50): Promise<{entries: HistoryEntry[]}> => {
        const url = new URL(`/api/notes/${encodeURIComponent(id)}/history`, window.location.origin);
        url.searchParams.set('limit', String(limit));
        return json(await fetch(url));
    },
    noteVersion: async (id: string, sha: string): Promise<{content: string; sha: string}> => {
        return json(await fetch(`/api/notes/${encodeURIComponent(id)}/version/${encodeURIComponent(sha)}`));
    },
    noteDiff: async (id: string, from: string, to?: string): Promise<{unified: string}> => {
        const url = new URL(`/api/notes/${encodeURIComponent(id)}/diff`, window.location.origin);
        url.searchParams.set('from', from);

        if (to !== undefined) {
            url.searchParams.set('to', to);
        }

        return json(await fetch(url));
    }
};

export interface HistoryEntry {
    sha: string;
    message: string;
    author: {name: string; email: string; date: string};
    parents: string[];
}