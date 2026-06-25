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

/**
 * Semantic relations for explicit, typed wikilinks stored in frontmatter
 * under the `links:` array. Mirrors the discussion in the project backlog
 * (#7 typed wikilinks). A typed link is purely a metadata declaration —
 * search ranking and graph topology continue to derive from body wikilinks.
 */
export type TypedLinkKind = 'supersedes' | 'duplicates' | 'relates_to' | 'replies_to';

export const TYPED_LINK_KINDS: readonly TypedLinkKind[] = [
    'supersedes',
    'duplicates',
    'relates_to',
    'replies_to'
] as const;

export interface TypedLink {
    /** Wikilink target (title or alias, same resolution as body `[[Target]]`). */
    target: string;
    kind: TypedLinkKind;
}

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
    links?: TypedLink[];
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

export type SearchSignalName = 'fulltext' | 'title' | 'semantic' | 'graph';

export interface SearchSignalComponent {
    /**
     * Raw signal score (BM25 magnitude, cosine similarity, title-match score).
     * Magnitudes are NOT comparable across signals — use `rank` for fair comparison.
     */
    score: number;
    /** 1-indexed rank within this signal's ranked list. RRF uses 1/(k+rank). */
    rank: number;
}

export interface SearchHitComponents {
    fulltext?: SearchSignalComponent;
    title?: SearchSignalComponent;
    semantic?: SearchSignalComponent;
    /**
     * Graph proximity to pinned + recently-touched seed notes. Hits that are
     * direct neighbours of seeds or share common neighbours (Adamic-Adar) rank
     * higher. Only present in hybrid mode when at least one seed exists.
     */
    graph?: SearchSignalComponent;
    /**
     * Multiplier applied after fusion (e.g. crawler-index demotion).
     * Only present when < 1. Final score = sum(1/(k+rank)) × demote.
     */
    demote?: number;
}

export interface SearchHit {
    noteId: NoteId;
    path: string;
    title: string;
    score: number;
    snippet?: string;
    chunkId?: string;
    /**
     * Per-signal breakdown explaining how the final score was assembled.
     * Optional — present when the searcher is configured to populate it.
     */
    components?: SearchHitComponents;
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