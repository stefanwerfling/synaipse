import type {CanvasDocument, Frontmatter, Graph, Note, SearchHit, SearchMode} from '@synaipse/core';

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
    /** DSGVO Layer 2 marker. Present only when true — omitted otherwise to keep the list-notes payload lean. */
    isPrivate?: true;
}

export type AuditKind = 'chat' | 'summarize' | 'compile' | 'relink' | 'research' | 'embed';

export interface AuditEntry {
    ts: number;
    provider: string;
    providerKind: 'local' | 'external';
    kind: AuditKind;
    noteIds: string[];
    redactions: Array<{kind: string; count: number}>;
    filteredPrivate?: number;
    question?: string;
    tokens?: {input?: number; output?: number; total?: number};
    durationMs?: number;
    embedSource?: 'search' | 'related' | 'suggest-links';
    embedCalls?: number;
    tokenLabel?: string;
}

// Client-side layout cache. The Louvain layout is stable within a short
// window (server recomputes on write) and mode-switches 2D→Atlas→3D would
// otherwise refetch several MB per hop. TTL is short so writes propagate
// naturally; writeNote/deleteNote also invalidate explicitly.
const LAYOUT_CACHE_TTL_MS = 60_000;
let layoutCache: {value: GraphLayout; ts: number} | null = null;
let layoutInflight: Promise<GraphLayout> | null = null;

const invalidateLayoutCache = (): void => {
    layoutCache = null;
};

export interface CanvasSummary {
    id: string;
    mtime: number;
    size: number;
}

export const api = {
    listNotes: async (): Promise<NoteSummary[]> => {
        return json(await fetch('/api/notes'));
    },
    listCanvases: async (): Promise<CanvasSummary[]> => {
        const {canvases} = await json<{canvases: CanvasSummary[]}>(await fetch('/api/canvases'));
        return canvases;
    },
    getCanvas: async (id: string): Promise<CanvasDocument> => {
        const url = new URL('/api/canvas', window.location.origin);
        url.searchParams.set('path', id);
        return json(await fetch(url));
    },
    putCanvas: async (id: string, doc: CanvasDocument): Promise<void> => {
        const url = new URL('/api/canvas', window.location.origin);
        url.searchParams.set('path', id);
        const response = await fetch(url, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(doc)
        });
        await noContent(response);
    },
    deleteCanvas: async (id: string): Promise<void> => {
        const url = new URL('/api/canvas', window.location.origin);
        url.searchParams.set('path', id);
        await noContent(await fetch(url, {method: 'DELETE'}));
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
        invalidateLayoutCache();
        return json(response);
    },
    deleteNote: async (id: string): Promise<void> => {
        await noContent(await fetch(`/api/notes/${encodeURIComponent(id)}`, {method: 'DELETE'}));
        invalidateLayoutCache();
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
    getGraphLayout: async (options: {force?: boolean} = {}): Promise<GraphLayout> => {
        const now = Date.now();

        if (!options.force && layoutCache !== null && now - layoutCache.ts < LAYOUT_CACHE_TTL_MS) {
            return layoutCache.value;
        }

        // De-dupe concurrent callers so a Mode-switch spam doesn't fire
        // multiple parallel fetches for the same payload.
        if (layoutInflight !== null) {
            return layoutInflight;
        }

        layoutInflight = (async () => {
            try {
                const value = await json<GraphLayout>(await fetch('/api/graph/layout'));
                layoutCache = {value, ts: Date.now()};
                return value;
            } finally {
                layoutInflight = null;
            }
        })();

        return layoutInflight;
    },
    invalidateGraphLayout: invalidateLayoutCache,
    getInfo: async (): Promise<{
        semanticEnabled: boolean;
        notesCount: number;
        project: string | null;
        historyEnabled: boolean;
        chatEnabled: boolean;
        chatModel: string | null;
        chatProvider: 'ollama' | 'openai' | 'anthropic' | 'claude-shell' | null;
        chatProviderIsLocal: boolean | null;
        researchEnabled: boolean;
        researchProvider: 'tavily' | 'searxng' | null;
    }> => {
        return json(await fetch('/api/info'));
    },
    chatPreview: async (payload: {question: string; pathPrefix?: string}): Promise<{
        providerIsLocal: boolean | null;
        filteredPrivate: number;
        redactions: Array<{kind: string; count: number}>;
        sources: Array<{index: number; noteId: string; title: string; score: number; snippet?: string}>;
    }> => {
        return json(await fetch('/api/chat/preview', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        }));
    },
    audit: async (opts: {limit?: number; afterTs?: number; provider?: string; kind?: AuditKind; includeEmbed?: boolean} = {}): Promise<{
        entries: AuditEntry[];
        total: number;
    }> => {
        const url = new URL('/api/audit', window.location.origin);
        if (opts.limit !== undefined) url.searchParams.set('limit', String(opts.limit));
        if (opts.afterTs !== undefined) url.searchParams.set('afterTs', String(opts.afterTs));
        if (opts.provider !== undefined) url.searchParams.set('provider', opts.provider);
        if (opts.kind !== undefined) url.searchParams.set('kind', opts.kind);
        if (opts.includeEmbed === true) url.searchParams.set('includeEmbed', '1');
        return json(await fetch(url));
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
    },
    verifyHistory: async (): Promise<VerifyResult> => {
        return json(await fetch('/api/health/verify'));
    },
    snapshotList: async (sha: string, treePath?: string): Promise<{sha: string; path: string; entries: SnapshotEntry[]}> => {
        const url = new URL(`/api/snapshot/${encodeURIComponent(sha)}`, window.location.origin);

        if (treePath !== undefined) {
            url.searchParams.set('path', treePath);
        }

        return json(await fetch(url));
    },
    listChats: async (): Promise<ChatSummary[]> => {
        return json(await fetch('/api/chats'));
    },
    getChat: async (id: string): Promise<ChatSession> => {
        return json(await fetch(`/api/chats/${encodeURIComponent(id)}`));
    },
    createChat: async (input: ChatSessionInput): Promise<ChatSession> => {
        const response = await fetch('/api/chats', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(input)
        });
        return json(response);
    },
    updateChat: async (id: string, input: ChatSessionInput): Promise<ChatSession> => {
        const response = await fetch(`/api/chats/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(input)
        });
        return json(response);
    },
    deleteChat: async (id: string): Promise<void> => {
        await noContent(await fetch(`/api/chats/${encodeURIComponent(id)}`, {method: 'DELETE'}));
    },
    saveChatAsNote: async (id: string): Promise<{noteId: string}> => {
        const response = await fetch(`/api/chats/${encodeURIComponent(id)}/save-as-note`, {
            method: 'POST'
        });
        return json(response);
    },
    uploadAsset: async (noteId: string, file: File): Promise<AssetUploadResult> => {
        const response = await fetch('/api/assets/upload', {
            method: 'POST',
            headers: {
                'Content-Type': file.type !== '' ? file.type : 'application/octet-stream',
                'X-Synaipse-Note-Id': encodeURIComponent(noteId)
            },
            body: file
        });
        return json(response);
    },
    summarizeNote: async function* (
        id: string,
        opts: {save?: boolean; signal?: AbortSignal} = {}
    ): AsyncGenerator<SummarizeEvent, void, void> {
        const response = await fetch(`/api/notes/${encodeURIComponent(id)}/summarize`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({save: opts.save === true}),
            ...(opts.signal !== undefined ? {signal: opts.signal} : {})
        });

        if (response.body === null) {
            throw new Error('no response body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const {value, done} = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, {stream: true});

            const parts = buffer.split('\n\n');
            buffer = parts.pop() ?? '';

            for (const block of parts) {
                const line = block.split('\n').find((l) => l.startsWith('data: '));
                if (line === undefined) continue;

                try {
                    yield JSON.parse(line.slice(6)) as SummarizeEvent;
                } catch {
                    // ignore malformed
                }
            }
        }
    }
};

export type SummarizeEvent =
    | {kind: 'token'; text: string}
    | {kind: 'done'; summary: string}
    | {kind: 'error'; message: string};

export interface ChatSourceRef {
    target: string;
    title: string;
    index: number;
    score?: number;
    snippet?: string;
}

export interface ChatTurnDto {
    role: 'user' | 'assistant';
    content: string;
    model?: string;
    sources?: ChatSourceRef[];
}

export interface ChatSession {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    lastModel?: string;
    turns: ChatTurnDto[];
}

export interface ChatSummary {
    id: string;
    title: string;
    updatedAt: string;
    lastModel?: string;
    turnCount: number;
}

export interface ChatSessionInput {
    title: string;
    lastModel?: string;
    turns: ChatTurnDto[];
}

export interface ChatgptImportAttachment {
    assetPointer: string;
    filename: string;
    mimeType: string | null;
    dataBase64: string;
}

export interface ChatgptImportMessage {
    role: 'user' | 'assistant' | 'system';
    text: string;
    createTime: number | null;
    assetPointers?: string[];
}

export interface ChatgptImportConversation {
    id: string;
    title: string;
    createTime: number;
    updateTime: number;
    model: string | null;
    messages: ChatgptImportMessage[];
    attachments: ChatgptImportAttachment[];
}

export interface GraphLayoutNode {
    id: string;
    x: number;
    y: number;
    community: number;
    degree: number;
}

export interface GraphLayoutCommunity {
    id: number;
    size: number;
    cx: number;
    cy: number;
    radius: number;
}

export interface InterCommunityEdge {
    from: number;
    to: number;
    weight: number;
}

export interface GraphLayout {
    hash: string;
    nodes: GraphLayoutNode[];
    communities: GraphLayoutCommunity[];
    interCommunityEdges: InterCommunityEdge[];
    bounds: {width: number; height: number};
    modularity: number;
}

export interface ActivityCommit {
    sha: string;
    ts: number;
    author: string;
    project: string | null;
    tool: string;
    noteId: string | null;
    subject: string;
}

export interface ActivityBucket {
    date: string;
    commits: number;
    notes: number;
}

export interface ActivityCount {
    key: string;
    count: number;
}

export interface ActivityReport {
    total: number;
    commits: ActivityCommit[];
    timeline: ActivityBucket[];
    hotNotes: Array<{noteId: string; edits: number}>;
    byTool: ActivityCount[];
    byProject: ActivityCount[];
}

export const activityApi = {
    get: async (days = 7, limit = 1000): Promise<ActivityReport> => {
        const url = new URL('/api/activity', window.location.origin);
        url.searchParams.set('days', String(days));
        url.searchParams.set('limit', String(limit));
        return json(await fetch(url));
    }
};

export type JobType = 'relink' | 'compile';

export type JobStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface JobRecord {
    id: string;
    type: JobType;
    params: {prefix: string; force?: boolean; useLlm?: boolean; limit?: number};
    status: JobStatus;
    progress: {done: number; total: number; failed: number; current?: string};
    startedAt: number;
    finishedAt?: number;
    error?: string;
    summary?: string;
    logs: string[];
}

export type JobEvent =
    | {kind: 'snapshot'; job: JobRecord}
    | {kind: 'progress'; done: number; total: number; failed: number; current?: string}
    | {kind: 'log'; message: string}
    | {kind: 'done'; summary: string}
    | {kind: 'failed'; error: string}
    | {kind: 'stopped'};

export const jobsApi = {
    list: async (): Promise<JobRecord[]> => json(await fetch('/api/jobs')),
    get: async (id: string): Promise<JobRecord> => json(await fetch(`/api/jobs/${encodeURIComponent(id)}`)),
    start: async (type: JobType, params: JobRecord['params']): Promise<JobRecord> => {
        const response = await fetch('/api/jobs', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({type, params})
        });
        return json(response);
    },
    stop: async (id: string): Promise<void> => {
        await fetch(`/api/jobs/${encodeURIComponent(id)}/stop`, {method: 'POST'});
    },
    stream: (id: string, onEvent: (event: JobEvent) => void, onError?: (e: Event) => void): () => void => {
        const es = new EventSource(`/api/jobs/${encodeURIComponent(id)}/stream`);
        es.onmessage = (evt) => {
            try {
                onEvent(JSON.parse(evt.data) as JobEvent);
            } catch {
                // ignore malformed
            }
        };
        if (onError !== undefined) es.onerror = onError;
        return () => es.close();
    }
};

export const importApi = {
    listExisting: async (): Promise<Record<string, string>> => {
        return json(await fetch('/api/import/chatgpt/existing'));
    },
    importConversation: async (
        conversation: ChatgptImportConversation
    ): Promise<{noteId: string; isUpdate: boolean}> => {
        const response = await fetch('/api/import/chatgpt', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({conversation})
        });
        return json(response);
    }
};

export interface AssetUploadResult {
    assetId: string;
    relativePath: string;
    written: number;
    deduped: boolean;
}

export interface SnapshotEntry {
    name: string;
    type: 'file' | 'dir';
    sha: string;
}

export type VerifyResult =
    | {enabled: false}
    | {enabled: true; checked: number; ok: boolean; corrupt: Array<{sha: string; reason: string}>};

export interface HistoryEntry {
    sha: string;
    message: string;
    author: {name: string; email: string; date: string};
    parents: string[];
}

export interface ConsentRequestSummary {
    id: string;
    noteId: string;
    requester: string;
    createdAt: string;
    resolvedAt?: string;
    decision?: 'granted' | 'denied';
}

export const consentApi = {
    listPending: async (): Promise<ConsentRequestSummary[]> => {
        const {requests} = await json<{requests: ConsentRequestSummary[]}>(
            await fetch('/api/consent/pending')
        );
        return requests;
    },
    approve: async (id: string): Promise<ConsentRequestSummary> => {
        const response = await fetch(`/api/consent/${encodeURIComponent(id)}/approve`, {method: 'POST'});
        const {request} = await json<{request: ConsentRequestSummary}>(response);
        return request;
    },
    deny: async (id: string): Promise<ConsentRequestSummary> => {
        const response = await fetch(`/api/consent/${encodeURIComponent(id)}/deny`, {method: 'POST'});
        const {request} = await json<{request: ConsentRequestSummary}>(response);
        return request;
    },
    // SSE stream with named events ("new" + "resolved") — replays the
    // current pending set on connect so a fresh subscriber doesn't need
    // a separate GET /pending round-trip.
    stream: (
        onNew: (req: ConsentRequestSummary) => void,
        onResolved: (req: ConsentRequestSummary) => void
    ): () => void => {
        const es = new EventSource('/api/consent/stream');
        const parse = (evt: MessageEvent): ConsentRequestSummary | null => {
            try {
                return JSON.parse(evt.data as string) as ConsentRequestSummary;
            } catch {
                return null;
            }
        };
        const handleNew = (evt: MessageEvent): void => {
            const r = parse(evt);
            if (r !== null) onNew(r);
        };
        const handleResolved = (evt: MessageEvent): void => {
            const r = parse(evt);
            if (r !== null) onResolved(r);
        };
        es.addEventListener('new', handleNew as EventListener);
        es.addEventListener('resolved', handleResolved as EventListener);
        return () => {
            es.removeEventListener('new', handleNew as EventListener);
            es.removeEventListener('resolved', handleResolved as EventListener);
            es.close();
        };
    }
};