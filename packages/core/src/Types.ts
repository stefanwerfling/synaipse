export type NoteId = string;

export type NoteType =
    | 'note'
    | 'decision'
    | 'bug'
    | 'fact'
    | 'concept'
    | 'todo'
    | 'question'
    | 'external';

export const NOTE_TYPES: readonly NoteType[] = [
    'note',
    'decision',
    'bug',
    'fact',
    'concept',
    'todo',
    'question',
    'external'
] as const;

export interface Frontmatter {
    [key: string]: unknown;
    title?: string;
    tags?: string[];
    aliases?: string[];
    created?: string;
    updated?: string;
    type?: NoteType;
    why?: string;
    confidence?: number;
    sources?: string[];
    supersedes?: string[];
    project?: string;
}

export interface Note {
    id: NoteId;
    path: string;
    title: string;
    content: string;
    frontmatter: Frontmatter;
    tags: string[];
    wikilinks: string[];
    backlinks: NoteId[];
    mtime: number;
    hash: string;
}

export interface NoteWriteInput {
    path: string;
    content: string;
    frontmatter?: Frontmatter;
}

export type SearchMode = 'fulltext' | 'semantic' | 'hybrid';

export interface SearchQuery {
    query: string;
    mode?: SearchMode;
    limit?: number;
    tags?: string[];
    paths?: string[];
}

export interface SearchHit {
    noteId: NoteId;
    path: string;
    title: string;
    score: number;
    snippet?: string;
    chunkId?: string;
}

export interface GraphNode {
    id: NoteId;
    title: string;
    tags: string[];
}

export interface GraphEdge {
    from: NoteId;
    to: NoteId;
    kind: 'wikilink' | 'tag';
}

export interface Graph {
    nodes: GraphNode[];
    edges: GraphEdge[];
}

export interface Chunk {
    id: string;
    noteId: NoteId;
    path: string;
    text: string;
    index: number;
}

export type VaultEvent =
    | { kind: 'created'; path: string }
    | { kind: 'updated'; path: string }
    | { kind: 'deleted'; path: string };