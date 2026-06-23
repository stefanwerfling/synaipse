import type {Config, Frontmatter, Note, NoteId, NoteWriteInput, SearchHit, SearchMode, Graph, VaultEvent} from '@synaipse/core';
import {ProjectScopeError} from '@synaipse/core';
import {Vault, VaultWatcher} from '@synaipse/vault';
import {Diff, PathNotFoundError, type PersonInput, type VerifyReport} from 'ngit';
import {runChat, runSummarize, type ChatEvent, type ChatOptions, type SummarizeEvent} from './Chat.js';
import {writeAsset, type WriteAssetResult} from './Assets.js';
import {buildActivityReport, type ActivityReport} from './Activity.js';
import {computeLayout, type GraphLayout} from './Layout.js';
import {renderCompiledMarkdown, runCompile, type CompileEvent, type CompileResult} from './Compile.js';
import {createLlmProvider, type LlmConfig, type LlmProvider, type LlmProviderKind} from './Llm.js';
import {
    renderRelatedSection,
    runRelink,
    stripRelatedSection,
    type AcceptedLink,
    type RelinkCandidate
} from './Relink.js';
import {
    createWebSearchProvider,
    runResearch,
    type ResearchEvent,
    type WebSearchConfig,
    type WebSearchProvider
} from './Research.js';
import {
    renderChatgptConversation,
    type ChatgptImportConversation
} from './ChatgptImport.js';
import {
    buildChatId,
    isChatNote,
    parseChatSession,
    serializeChatSession,
    type ChatSession,
    type ChatSummary,
    type ChatTurn
} from './ChatStore.js';
import {ChatRepo} from './ChatRepo.js';
export type {ChatEvent, ChatSource, ChatOptions, ChatMessage, SummarizeEvent} from './Chat.js';
export type {ChatSession, ChatSummary, ChatTurn, ChatSourceRef} from './ChatStore.js';
export type {WriteAssetResult} from './Assets.js';
export type {ActivityReport, ActivityCommit, ActivityBucket, ActivityCount} from './Activity.js';
export type {GraphLayout, LayoutNode, LayoutCommunity} from './Layout.js';
export type {CompileEvent, CompileResult} from './Compile.js';
export type {LlmConfig, LlmProvider, LlmProviderKind} from './Llm.js';
export type {RelinkCandidate, RelinkEvent} from './Relink.js';
export type {ResearchEvent, WebSearchConfig, WebSearchProvider} from './Research.js';
export type {
    ChatgptImportAttachment,
    ChatgptImportConversation,
    ChatgptImportMessage
} from './ChatgptImport.js';

export interface SnapshotEntry {
    name: string;
    type: 'file' | 'dir';
    sha: string;
}
import {createEmbedder, QdrantStore, VectorIndex} from '@synaipse/vector';
import {annotateSingleSignal, defaultDemote, reciprocalRankFusion, type RankedSignal} from './Fusion.js';
import {buildAdjacency, rankByGraphProximity, type AdjacencyMap} from './Graph.js';
import {InvertedIndex} from './InvertedIndex.js';
import {HashCache} from './Cache.js';

export interface IndexingStats {
    total: number;
    reindexed: number;
    removed: number;
    unchanged: number;
}

export interface RelatedNote {
    id: NoteId;
    title: string;
    score: number;
    reasons: string[];
}

export interface LinkSuggestion {
    a: NoteId;
    aTitle: string;
    b: NoteId;
    bTitle: string;
    score: number;
    reasons: string[];
    sharedTags?: string[];
}

export interface SuggestLinksOptions {
    limit?: number;
    minScore?: number;
    pathPrefix?: string;
}

export interface StaleNote {
    id: NoteId;
    title: string;
    tags: string[];
    mtime: number;
    lastAccessed?: number;
    accessCount: number;
    ageDays: number;
}

export interface StaleNotesOptions {
    olderThanDays?: number;
    pathPrefix?: string;
    limit?: number;
}

const MS_PER_DAY = 86_400_000;

const GRAPH_SEED_RECENT_WINDOW_MS = 7 * MS_PER_DAY;
const GRAPH_SEED_RECENT_CAP = 10;

const extractExcerpt = (content: string, max: number): string => {
    const body = content.replace(/^---[\s\S]*?---\s*/, '').trim();
    const flat = body.replace(/[#*_`>[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
    return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
};

export interface TodoItem {
    noteId: NoteId;
    title: string;
    line: number;
    text: string;
    done: boolean;
}

export type PrimerReason = 'pinned' | 'recent_session' | 'project_decision' | 'hot' | 'recent' | 'topic';

export interface PrimerEntry {
    id: NoteId;
    title: string;
    reason: PrimerReason;
    excerpt: string;
    tags: string[];
    mtime: number;
    backlinkCount: number;
}

export interface PrimeOptions {
    project?: string | null;
    limit?: number;
    topic?: string;
    includeCrawler?: boolean;
}

export interface PrimeResult {
    project: string | null;
    todoCount: number;
    todoSample: TodoItem[];
    context: PrimerEntry[];
    /**
     * Rough token estimate for the context + todoSample payload (≈ chars / 4).
     * Lets callers surface what loading this bundle costs in Claude's context window.
     * Not a precise tokenizer — order-of-magnitude indicator.
     */
    tokenEstimate: number;
}

export interface UpdateNoteInput {
    content?: string;
    frontmatterPatch?: Frontmatter;
}

export interface ProjectOpts {
    project?: string | null;
    gitAuthor?: PersonInput;
    extraTags?: readonly string[];
}

export interface NoteHistoryEntry {
    sha: string;
    message: string;
    author: {name: string; email: string; date: string};
    parents: string[];
}

const isoDate = (timestamp: number): string => new Date(timestamp * 1000).toISOString();

const buildCommitMessage = (tool: string, noteId: string, project: string | null): string => {
    const scope = project === null ? 'synaipse' : `synaipse(${project})`;
    return `${scope}: ${tool} ${noteId}`;
};

const isPathNotFound = (err: unknown): boolean => {
    if (err instanceof PathNotFoundError) {
        return true;
    }

    return err instanceof Error && err.name === 'PathNotFoundError';
};

const TODO_REGEX = /^\s*-\s+\[([ xX])\]\s+(.+?)\s*$/;
const SEMANTIC_SAMPLE_CHARS = 1500;

type ChatConfigField = NonNullable<Config['chat']>;
type ResearchConfigField = NonNullable<Config['research']>;

const toWebSearchConfig = (research: ResearchConfigField): WebSearchConfig => {
    if (research.provider === 'tavily') {
        return {kind: 'tavily', apiKey: research.apiKey ?? ''};
    }
    return {kind: 'searxng', url: research.url ?? ''};
};

const toLlmConfig = (chat: ChatConfigField): LlmConfig => {
    if (chat.provider === 'ollama') {
        return {kind: 'ollama', url: chat.url ?? 'http://localhost:11434', model: chat.model};
    }

    if (chat.provider === 'openai') {
        return {
            kind: 'openai',
            url: chat.url ?? 'https://api.openai.com',
            model: chat.model,
            ...(chat.apiKey !== undefined ? {apiKey: chat.apiKey} : {})
        };
    }

    if (chat.provider === 'anthropic') {
        return {
            kind: 'anthropic',
            model: chat.model,
            apiKey: chat.apiKey ?? '',
            ...(chat.url !== undefined ? {url: chat.url} : {})
        };
    }

    return {kind: 'claude-shell', command: chat.command ?? 'claude', model: chat.model};
};

const slugifyForPath = (input: string): string => {
    const out = input
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);

    return out.length === 0 ? 'chat' : out;
};

export type VaultChangeListener = (event: VaultEvent & {noteId: NoteId}) => void;

export class SynaipseService {
    private readonly vault: Vault;
    private readonly index: VectorIndex | null;
    private readonly watcher: VaultWatcher;
    private readonly cache: HashCache;
    private readonly chatRepo: ChatRepo;
    private readonly fulltextIndex = new InvertedIndex();
    private readonly project: string | null;
    private readonly configProjectExtraTags: readonly string[];
    private readonly chatProvider: LlmProvider | null;
    private readonly researchProvider: WebSearchProvider | null;
    private readonly embedExcludePrefixes: readonly string[];
    private cachedLayout: GraphLayout | null = null;
    private cachedLayoutKey: string | null = null;
    private cachedGraph: Graph | null = null;
    private cachedAdjacency: AdjacencyMap | null = null;
    private lastStats: IndexingStats = {total: 0, reindexed: 0, removed: 0, unchanged: 0};
    private readonly vaultChangeListeners = new Set<VaultChangeListener>();

    public constructor(config: Config) {
        const git = config.git ?? {
            autoCommit: true,
            author: {name: 'Synaipse', email: 'synaipse@local'}
        };

        this.vault = new Vault(config.vaultPath, {
            history: {autoCommit: git.autoCommit, author: git.author}
        });
        this.cache = new HashCache(config.indexCachePath);
        this.chatRepo = new ChatRepo(config.chatStoreDir);
        this.watcher = new VaultWatcher(config.vaultPath);
        this.project = config.project?.name ?? null;
        this.configProjectExtraTags = config.project?.extraTags ?? [];
        this.chatProvider = config.chat !== undefined
            ? createLlmProvider(toLlmConfig(config.chat))
            : null;

        this.researchProvider = config.research !== undefined
            ? createWebSearchProvider(toWebSearchConfig(config.research))
            : null;

        this.embedExcludePrefixes = config.embedExcludePrefixes ?? [];

        const embedder = createEmbedder(config);

        if (embedder === null) {
            this.index = null;
            return;
        }

        const store = new QdrantStore({
            url: config.qdrant.url,
            ...(config.qdrant.apiKey !== undefined ? {apiKey: config.qdrant.apiKey} : {}),
            collection: config.qdrant.collection,
            dimension: embedder.dimension,
            retry: {
                onRetry: ({attempt, error, waitMs}) => {
                    const reason = error instanceof Error ? error.message : String(error);
                    process.stderr.write(`[synaipse] qdrant retry #${attempt} reason="${reason}" wait=${waitMs}ms\n`);
                }
            }
        });

        this.index = new VectorIndex({
            embedder,
            store,
            onBatch: ({batch, batches, chunks, chars}) => {
                process.stderr.write(`[synaipse] embed batch ${batch}/${batches} (${chunks} chunks, ${chars} chars)\n`);
            },
            onOversize: (chunk) => {
                process.stderr.write(`[synaipse] WARN oversize chunk ${chunk.id} (${chunk.text.length} chars) — tune CHUNK_DEFAULTS\n`);
            }
        });
    }

    private shouldEmbed(noteId: NoteId): boolean {
        return !this.embedExcludePrefixes.some((p) => noteId.startsWith(p));
    }

    private async maybeIndexNote(note: Note): Promise<void> {
        if (this.index !== null && this.shouldEmbed(note.id)) {
            await this.index.indexNote(note);
        }

        this.invalidateTopologyCaches();
    }

    private invalidateTopologyCaches(): void {
        // Topology might have changed (new/removed note or edited wikilinks).
        // Drop the memoised graph, Atlas layout, and search-time adjacency
        // map; the next request rebuilds them lazily.
        this.cachedLayout = null;
        this.cachedLayoutKey = null;
        this.cachedGraph = null;
        this.cachedAdjacency = null;
    }

    public async start(): Promise<void> {
        await Promise.all([this.vault.load(), this.cache.load()]);

        // Migrate any chats that ended up in the vault during the brief
        // window where the chat layer was vault-backed. After this runs
        // once, the vault is chat-free and the chat store is the sole
        // home for conversations.
        await this.migrateLegacyChatNotesOut();

        this.fulltextIndex.build(this.vault.list());
        process.stderr.write(`[synaipse] fulltext index: ${this.fulltextIndex.size()} notes · ${this.fulltextIndex.termCount()} terms\n`);

        if (this.index === null) {
            process.stderr.write(`[synaipse] embeddings disabled (provider=none) — fulltext only, ${this.vault.list().length} notes loaded\n`);
            this.attachWatcher();
            this.warmGraphCaches();
            return;
        }

        if (this.embedExcludePrefixes.length > 0) {
            process.stderr.write(`[synaipse] embed exclude prefixes: ${this.embedExcludePrefixes.join(', ')}\n`);
        }

        const stats: IndexingStats = {total: 0, reindexed: 0, removed: 0, unchanged: 0};
        const liveIds = new Set<NoteId>();
        const toReindex: Note[] = [];
        let excluded = 0;

        for (const note of this.vault.list()) {
            stats.total += 1;
            liveIds.add(note.id);

            if (!this.shouldEmbed(note.id)) {
                excluded += 1;
                continue;
            }

            const cached = this.cache.get(note.id);

            if (cached && cached.hash === note.hash) {
                stats.unchanged += 1;
                continue;
            }

            toReindex.push(note);
        }

        if (excluded > 0) {
            process.stderr.write(`[synaipse] embed: skipped ${excluded} notes by exclude-prefix\n`);
        }

        const orphans: NoteId[] = this.cache.ids().filter((id) => !liveIds.has(id));

        if (toReindex.length > 0) {
            await this.index.indexNotes(toReindex);

            for (const note of toReindex) {
                this.cache.set(note.id, {hash: note.hash, mtime: note.mtime});
            }

            stats.reindexed = toReindex.length;
        }

        if (orphans.length > 0) {
            await this.index.deleteNotes(orphans);

            for (const id of orphans) {
                this.cache.delete(id);
            }

            stats.removed = orphans.length;
        }

        await this.cache.flush();
        this.lastStats = stats;

        process.stderr.write(
            `[synaipse] indexed: ${stats.reindexed} reindexed, ${stats.unchanged} unchanged, ${stats.removed} removed (total ${stats.total})\n`
        );

        this.attachWatcher();
        this.warmGraphCaches();
    }

    /** Build graph + Atlas layout so the first request after startup is instant. */
    private warmGraphCaches(): void {
        const started = Date.now();
        const graph = this.graph();
        this.graphLayout();
        const ms = Date.now() - started;
        process.stderr.write(
            `[synaipse] graph cache warmed: ${graph.nodes.length} nodes, ${graph.edges.length} edges in ${ms}ms\n`
        );
    }

    public async stop(): Promise<void> {
        await this.watcher.stop();
        await this.cache.flush();
    }

    public getLastIndexingStats(): IndexingStats {
        return this.lastStats;
    }

    public getVault(): Vault {
        return this.vault;
    }

    public hasSemanticIndex(): boolean {
        return this.index !== null;
    }

    public async search(query: string, mode: SearchMode, limit: number): Promise<SearchHit[]> {
        const hits = await this.runSearch(query, mode, limit);

        for (const hit of hits) {
            this.touchAccess(hit.noteId);
        }

        return hits;
    }

    private async runSearch(query: string, mode: SearchMode, limit: number): Promise<SearchHit[]> {
        if (mode === 'fulltext') {
            return annotateSingleSignal(this.fulltextIndex.search(query, limit), 'fulltext');
        }

        if (mode === 'semantic') {
            // Graceful fallback when a semantic-only query lands on an
            // embeddings-disabled service — better to return fulltext hits
            // than an empty list.
            if (this.index === null) {
                return annotateSingleSignal(this.fulltextIndex.search(query, limit), 'fulltext');
            }
            return annotateSingleSignal(await this.index.semanticSearch(query, limit), 'semantic');
        }

        // hybrid: title + fulltext + (semantic if available) + (graph if seeds)
        const ft = this.fulltextIndex.search(query, limit);
        const titles = this.fulltextIndex.searchTitle(query, limit);
        const sem = this.index !== null
            ? await this.index.semanticSearch(query, limit)
            : [];

        const signals: RankedSignal[] = [
            {name: 'title', hits: titles},
            {name: 'fulltext', hits: ft}
        ];
        if (sem.length > 0) signals.push({name: 'semantic', hits: sem});

        const graph = this.buildGraphSignal([titles, sem, ft], limit);
        if (graph !== null) signals.push(graph);

        return reciprocalRankFusion(signals, {
            limit,
            weightFor: defaultDemote((id) => this.vault.tryGet(id))
        });
    }

    /**
     * Construct a graph-proximity signal for the candidate union of the other
     * search signals. Returns null when there are no seed notes (pinned +
     * recently-touched) or no candidate has a positive proximity score — the
     * signal then contributes nothing and isn't added to the fusion.
     */
    private buildGraphSignal(
        candidateLists: readonly (readonly SearchHit[])[],
        limit: number
    ): RankedSignal | null {
        const seeds = this.collectGraphSeeds();
        if (seeds.length === 0) return null;

        const seen = new Set<NoteId>();
        const candidates: SearchHit[] = [];
        for (const list of candidateLists) {
            for (const hit of list) {
                if (seen.has(hit.noteId)) continue;
                seen.add(hit.noteId);
                candidates.push(hit);
            }
        }

        if (candidates.length === 0) return null;

        const hits = rankByGraphProximity(candidates, seeds, this.adjacency()).slice(0, limit);
        if (hits.length === 0) return null;

        return {name: 'graph', hits};
    }

    private adjacency(): AdjacencyMap {
        if (this.cachedAdjacency !== null) return this.cachedAdjacency;

        const notes = this.vault.list();
        const keyToId = new Map<string, NoteId>();

        for (const note of notes) {
            if (note.title.length > 0 && !keyToId.has(note.title)) {
                keyToId.set(note.title, note.id);
            }
        }

        for (const note of notes) {
            const aliases = note.frontmatter.aliases;
            if (aliases === undefined) continue;
            for (const alias of aliases) {
                if (alias.length > 0 && !keyToId.has(alias)) {
                    keyToId.set(alias, note.id);
                }
            }
        }

        this.cachedAdjacency = buildAdjacency(notes, (key) => keyToId.get(key));
        return this.cachedAdjacency;
    }

    /**
     * Seed set for graph-signal ranking: pinned notes (frontmatter `pinned`
     * or `prime` truthy) plus notes touched recently via the access cache.
     * Capped so the per-candidate AA sum stays bounded.
     */
    private collectGraphSeeds(): NoteId[] {
        const seeds = new Set<NoteId>();

        for (const note of this.vault.list()) {
            const fm = note.frontmatter;
            if (fm['pinned'] === true || fm['prime'] === true) {
                seeds.add(note.id);
            }
        }

        const recent: {id: NoteId; lastAccessed: number}[] = [];
        const cutoff = Date.now() - GRAPH_SEED_RECENT_WINDOW_MS;
        for (const id of this.cache.ids()) {
            const entry = this.cache.get(id);
            const lastAccessed = entry?.lastAccessed;
            if (lastAccessed === undefined || lastAccessed < cutoff) continue;
            if (this.vault.tryGet(id) === undefined) continue;
            recent.push({id, lastAccessed});
        }

        recent.sort((a, b) => b.lastAccessed - a.lastAccessed);
        for (const {id} of recent.slice(0, GRAPH_SEED_RECENT_CAP)) {
            seeds.add(id);
        }

        return [...seeds];
    }

    public getProject(override?: string | null): string | null {
        return override ?? this.project;
    }

    public getConfigExtraTags(): readonly string[] {
        return this.configProjectExtraTags;
    }

    public async noteHistory(id: NoteId, limit = 50): Promise<NoteHistoryEntry[]> {
        const repo = await this.vault.getRepo();

        if (repo === null) {
            return [];
        }

        let entries;

        try {
            entries = await repo.log({path: id, limit});
        } catch (cause) {
            if (isPathNotFound(cause)) {
                return [];
            }
            throw cause;
        }

        return entries.map((e) => ({
            sha: e.sha,
            message: e.message.trim(),
            author: {
                name: e.author.name,
                email: e.author.email,
                date: isoDate(e.author.timestamp)
            },
            parents: e.parents
        }));
    }

    public async getActivity(opts: {sinceDays?: number; limit?: number} = {}): Promise<ActivityReport> {
        const repo = await this.vault.getRepo();

        if (repo === null) {
            return {total: 0, commits: [], timeline: [], hotNotes: [], byTool: [], byProject: []};
        }

        // Overfetch — log has no time filter, so we just pull the most recent
        // N commits and filter by date in buildActivityReport.
        const fetchLimit = opts.limit ?? 1000;
        const entries = await repo.log({limit: fetchLimit});

        return buildActivityReport(
            entries.map((e) => ({
                sha: e.sha,
                author: {name: e.author.name, date: isoDate(e.author.timestamp)},
                message: e.message
            })),
            {
                ...(opts.sinceDays !== undefined ? {sinceDays: opts.sinceDays} : {}),
                commitsCap: 100,
                hotNotesTop: 10
            }
        );
    }

    public async noteVersion(id: NoteId, commitSha: string): Promise<string> {
        const repo = await this.vault.getRepo();

        if (repo === null) {
            throw new Error('history disabled — no .ngit found in vault');
        }

        const buf = await repo.show(commitSha, id);
        return buf.toString('utf8');
    }

    public async noteDiff(id: NoteId, fromSha: string, toSha?: string): Promise<string> {
        const repo = await this.vault.getRepo();

        if (repo === null) {
            return '';
        }

        const resolvedTo = toSha ?? (await repo.head());

        if (resolvedTo === null) {
            return '';
        }

        try {
            const [before, after] = await Promise.all([
                repo.show(fromSha, id).then((b) => b.toString('utf8')),
                repo.show(resolvedTo, id).then((b) => b.toString('utf8'))
            ]);

            return Diff.unified(before, after, {
                fromLabel: `${id} @ ${fromSha.slice(0, 7)}`,
                toLabel: `${id} @ ${resolvedTo.slice(0, 7)}`
            });
        } catch (cause) {
            if (isPathNotFound(cause)) {
                return '';
            }
            throw cause;
        }
    }

    /** True whenever the History UI should be available — feature is configured. The repo may not be initialised yet (no Synaipse-driven write has happened), in which case noteHistory/snapshot etc. just return empty results. */
    public async writeNoteAsset(noteId: NoteId, content: Buffer, contentType: string | null): Promise<WriteAssetResult> {
        return writeAsset({
            vaultPath: this.vault.root,
            noteId,
            content,
            contentType
        });
    }

    /**
     * Write an asset with project-scope enforcement. If `noteId` is given,
     * it must live inside the active project folder; the returned relativePath
     * is computed against it. If absent and a project scope is active, the
     * asset still lands in `Memory/<project>/_assets/` (relativePath is then
     * left undefined since there's no anchor note).
     */
    public async writeAssetScoped(
        input: {content: Buffer; contentType: string | null; noteId?: NoteId},
        opts?: ProjectOpts
    ): Promise<{assetId: string; written: number; deduped: boolean; relativePath?: string}> {
        const project = this.requireProject('write_asset', opts?.project);
        const prefix = this.projectFolder(project);

        if (input.noteId !== undefined && input.noteId.length > 0) {
            if (!input.noteId.startsWith(prefix)) {
                throw new ProjectScopeError(
                    `write_asset blocked: ${input.noteId} is outside project scope (${project}). Project notes live under ${prefix}.`
                );
            }

            return writeAsset({
                vaultPath: this.vault.root,
                noteId: input.noteId,
                content: input.content,
                contentType: input.contentType
            });
        }

        // No anchor note — synthesise a virtual id inside the project folder
        // so assetsFolderForNote routes to Memory/<project>/_assets, then drop
        // relativePath from the result since there's no real note to be
        // relative to.
        const result = await writeAsset({
            vaultPath: this.vault.root,
            noteId: `${prefix}.virtual.md`,
            content: input.content,
            contentType: input.contentType
        });

        return {assetId: result.assetId, written: result.written, deduped: result.deduped};
    }

    public chatEnabled(): boolean {
        return this.chatProvider !== null;
    }

    public getChatModel(): string | null {
        return this.chatProvider?.model ?? null;
    }

    public getChatProviderKind(): LlmProviderKind | null {
        return this.chatProvider?.kind ?? null;
    }

    public researchEnabled(): boolean {
        return this.researchProvider !== null && this.chatProvider !== null;
    }

    public getResearchProviderKind(): 'tavily' | 'searxng' | null {
        return this.researchProvider?.kind ?? null;
    }

    public async *research(question: string, opts: {abort?: AbortSignal} = {}): AsyncGenerator<ResearchEvent, void, void> {
        if (this.chatProvider === null) {
            yield {kind: 'error', message: 'chat LLM not configured — set SYNAIPSE_CHAT_PROVIDER'};
            return;
        }

        if (this.researchProvider === null) {
            yield {kind: 'error', message: 'research not configured — set SYNAIPSE_RESEARCH_PROVIDER (tavily or searxng)'};
            return;
        }

        yield* runResearch(
            {llm: this.chatProvider, search: this.researchProvider},
            {question, ...(opts.abort !== undefined ? {abort: opts.abort} : {})}
        );
    }

    /** Exposed so other features (crawler-compile, deep-research) can borrow the configured LLM. */
    public getChatProvider(): LlmProvider | null {
        return this.chatProvider;
    }

    public async *summarizeNote(id: NoteId, opts: {abort?: AbortSignal; saveToFrontmatter?: boolean; projectOverride?: string | null} = {}): AsyncGenerator<SummarizeEvent, void, void> {
        const provider = this.chatProvider;

        if (provider === null) {
            yield {kind: 'error', message: 'chat not configured — set SYNAIPSE_CHAT_URL + SYNAIPSE_CHAT_MODEL'};
            return;
        }

        const note = this.vault.tryGet(id);

        if (note === undefined) {
            yield {kind: 'error', message: `note not found: ${id}`};
            return;
        }

        let finalSummary = '';

        for await (const event of runSummarize(provider, note.content, opts.abort)) {
            yield event;

            if (event.kind === 'done') {
                finalSummary = event.summary;
            }
        }

        if (finalSummary.length > 0 && opts.saveToFrontmatter === true) {
            try {
                await this.updateNote(id, {frontmatterPatch: {summary: finalSummary}}, {
                    project: opts.projectOverride ?? null
                });
            } catch (cause) {
                yield {kind: 'error', message: `saved summary failed: ${String(cause)}`};
            }
        }
    }

    public async *chat(options: ChatOptions): AsyncGenerator<ChatEvent, void, void> {
        const provider = this.chatProvider;

        if (provider === null) {
            yield {kind: 'error', message: 'chat not configured — set SYNAIPSE_CHAT_URL + SYNAIPSE_CHAT_MODEL'};
            return;
        }

        yield* runChat({
            search: async (q, prefix, limit) => {
                const scoped = prefix !== undefined && prefix.length > 0;
                // Over-fetch when scoping by prefix so the filter still has enough
                // candidates to keep `limit` strong post-filter.
                const overFetch = scoped ? Math.max(limit * 6, 60) : limit;
                const hits = await this.search(q, 'hybrid', overFetch);

                if (!scoped) {
                    return hits.slice(0, limit);
                }

                return hits.filter((h) => h.noteId.startsWith(prefix)).slice(0, limit);
            },
            readNote: (id) => this.vault.tryGet(id)?.content,
            provider
        }, options);
    }

    public async historyEnabled(): Promise<boolean> {
        if (this.vault.isHistoryConfigured()) {
            return true;
        }

        return (await this.vault.getRepo()) !== null;
    }

    public async verifyHistory(): Promise<VerifyReport | null> {
        const repo = await this.vault.getRepo();

        if (repo === null) {
            return null;
        }

        return repo.verify();
    }

    public async snapshotList(commitSha: string, treePath?: string): Promise<SnapshotEntry[]> {
        const repo = await this.vault.getRepo();

        if (repo === null) {
            return [];
        }

        const snap = repo.at(commitSha);
        const entries = await snap.list(treePath);
        return entries.map((e) => ({name: e.name, type: e.type, sha: e.sha}));
    }

    public async snapshotWalk(commitSha: string, pathPrefix = ''): Promise<{path: string; sha: string}[]> {
        const repo = await this.vault.getRepo();

        if (repo === null) {
            return [];
        }

        const snap = repo.at(commitSha);
        const result: {path: string; sha: string}[] = [];

        for await (const entry of snap.walk()) {
            if (pathPrefix.length === 0 || entry.path.startsWith(pathPrefix)) {
                result.push(entry);
            }
        }

        return result;
    }

    private requireProject(op: string, override?: string | null): string {
        const resolved = override ?? this.project;

        if (resolved === null || resolved === '') {
            throw new ProjectScopeError(
                `${op} requires a project context. Set SYNAIPSE_PROJECT in the MCP server env, ` +
                `or pass it per-request via URL path /mcp/<project> or header X-Synaipse-Project.`
            );
        }

        return resolved;
    }

    private projectFolder(project: string): string {
        return `Memory/${project}/`;
    }

    private projectTag(project: string): string {
        return `project/${project}`;
    }

    private assertInProject(id: NoteId, op: string, override?: string | null): void {
        const project = this.requireProject(op, override);
        const prefix = this.projectFolder(project);

        if (!id.startsWith(prefix)) {
            throw new ProjectScopeError(
                `${op} blocked: ${id} is outside project scope (${project}). Project notes live under ${prefix}.`
            );
        }
    }

    private normaliseWritePath(rawPath: string, project: string): string {
        const trimmed = rawPath.replace(/^\/+/, '');

        if (trimmed.length === 0) {
            throw new ProjectScopeError('write path is empty');
        }

        const projectPrefix = this.projectFolder(project);

        if (trimmed.startsWith(projectPrefix)) {
            return trimmed;
        }

        if (trimmed.startsWith('Memory/')) {
            const rest = trimmed.slice('Memory/'.length);
            const firstSlash = rest.indexOf('/');

            if (firstSlash > 0) {
                return `${projectPrefix}${rest.slice(firstSlash + 1)}`;
            }

            return `${projectPrefix}${rest}`;
        }

        return `${projectPrefix}${trimmed}`;
    }

    private applyProjectToFrontmatter(
        frontmatter: Frontmatter | undefined,
        project: string,
        extraTags: readonly string[] = []
    ): Frontmatter {
        const base: Frontmatter = frontmatter ? {...frontmatter} : {};
        const projectTag = this.projectTag(project);
        const existingTags = Array.isArray(base.tags)
            ? base.tags.filter((t): t is string => typeof t === 'string')
            : [];

        const merged = [...existingTags];

        for (const tag of [projectTag, ...extraTags]) {
            if (!merged.includes(tag)) {
                merged.push(tag);
            }
        }

        base.project = project;
        base.tags = merged;

        return base;
    }

    private resolveExtraTags(perCall: readonly string[] | undefined): readonly string[] {
        return perCall ?? this.configProjectExtraTags;
    }

    public async writeNote(input: NoteWriteInput, opts?: ProjectOpts, commitTool = 'write_note'): Promise<Note> {
        const project = this.requireProject('write_note', opts?.project);
        const extraTags = this.resolveExtraTags(opts?.extraTags);

        const scoped: NoteWriteInput = {
            path: this.normaliseWritePath(input.path, project),
            content: input.content,
            frontmatter: this.applyProjectToFrontmatter(input.frontmatter, project, extraTags)
        };

        const note = await this.vault.write(scoped, {
            message: buildCommitMessage(commitTool, scoped.path, project),
            ...(opts?.gitAuthor !== undefined ? {author: opts.gitAuthor} : {})
        });

        await this.maybeIndexNote(note);
        this.fulltextIndex.addNote(note);
        this.cache.set(note.id, {hash: note.hash, mtime: note.mtime});
        await this.cache.flush();
        return note;
    }

    /** Map of ChatGPT conversation UUID → existing vault note id, scanning frontmatter.chatgpt_id. */
    public listChatgptImports(): Map<string, NoteId> {
        const out = new Map<string, NoteId>();

        for (const note of this.vault.list()) {
            const id = note.frontmatter.chatgpt_id;

            if (typeof id === 'string' && id.length > 0) {
                out.set(id, note.id);
            }
        }

        return out;
    }

    public async *compileNote(
        id: NoteId,
        opts: {abort?: AbortSignal; force?: boolean} = {}
    ): AsyncGenerator<CompileEvent & {compiledPath?: NoteId}, void, void> {
        const provider = this.chatProvider;

        if (provider === null) {
            yield {kind: 'error', message: 'chat not configured — set SYNAIPSE_CHAT_PROVIDER + model'};
            return;
        }

        const note = this.vault.tryGet(id);

        if (note === undefined) {
            yield {kind: 'error', message: `note not found: ${id}`};
            return;
        }

        // Sibling note path: drop the .md suffix, append .compiled.md
        const compiledPath = id.replace(/\.md$/i, '.compiled.md');
        const existing = this.vault.tryGet(compiledPath);

        if (existing !== undefined && opts.force !== true) {
            const sourceHash = existing.frontmatter.source_hash;
            if (sourceHash === note.hash) {
                yield {kind: 'done', result: null, compiledPath};
                return;
            }
        }

        let final: CompileResult | null = null;

        for await (const event of runCompile(provider, note.content, opts.abort)) {
            yield event;
            if (event.kind === 'done') final = event.result;
        }

        if (final === null) return;

        const markdown = renderCompiledMarkdown(note.id, note.title, final);

        const written = await this.vault.write({
            path: compiledPath,
            content: markdown,
            frontmatter: {
                title: `${note.title} — compiled`,
                source_note: note.id,
                source_hash: note.hash,
                source: 'compiled',
                tags: ['compiled', ...(note.tags.length > 0 ? [note.tags[0] as string] : [])],
                compiled_with: `${provider.kind}:${provider.model}`,
                compiled_at: new Date().toISOString().slice(0, 10)
            }
        }, {message: `synaipse: compile ${compiledPath}`});

        await this.maybeIndexNote(written);
        this.fulltextIndex.addNote(written);
        this.cache.set(written.id, {hash: written.hash, mtime: written.mtime});
        await this.cache.flush();

        yield {kind: 'done', result: final, compiledPath: written.id};
    }

    public async relinkNote(
        id: NoteId,
        opts: {
            useLlm?: boolean;
            force?: boolean;
            limit?: number;
            abort?: AbortSignal;
            /** Note IDs starting with one of these prefixes are excluded from
             * the candidate pool. Defaults to the high-noise dumping folders. */
            excludePrefixes?: readonly string[];
        } = {}
    ): Promise<{noteId: NoteId; accepted: AcceptedLink[]; skipped: boolean}> {
        const note = this.vault.tryGet(id);
        if (note === undefined) throw new Error(`note not found: ${id}`);

        // Idempotency: if the note already has an explicit ## Related section
        // and the caller didn't force, treat as no-op.
        if (!opts.force && /\n## Related\n/.test(note.content)) {
            return {noteId: id, accepted: [], skipped: true};
        }

        const excludePrefixes = opts.excludePrefixes ?? ['chatgpt-import/', 'Clipped/'];
        // Over-fetch because we'll filter out exclude-prefix hits before LLM/ranking.
        const fetchLimit = Math.max(opts.limit ?? 20, 40);
        const query = `${note.title}\n${note.content.replace(/^---[\s\S]*?---\n?/, '').slice(0, 400)}`;
        const hits = await this.search(query, 'hybrid', fetchLimit);

        const candidates: RelinkCandidate[] = [];
        const titlesSeen = new Set<string>([note.title]);

        for (const hit of hits) {
            if (hit.noteId === id) continue;
            if (titlesSeen.has(hit.title)) continue;
            if (excludePrefixes.some((p) => hit.noteId.startsWith(p))) continue;
            titlesSeen.add(hit.title);

            candidates.push({
                noteId: hit.noteId,
                title: hit.title,
                score: hit.score,
                ...(hit.snippet !== undefined ? {snippet: hit.snippet} : {})
            });

            if (candidates.length >= (opts.limit ?? 20)) break;
        }

        if (candidates.length === 0) {
            return {noteId: id, accepted: [], skipped: false};
        }

        let accepted: AcceptedLink[];

        if (opts.useLlm === true && this.chatProvider !== null) {
            const noteSnippet = note.content.replace(/^---[\s\S]*?---\n?/, '').slice(0, 1200);
            let finalAccepted: AcceptedLink[] | null = null;

            for await (const event of runRelink(
                this.chatProvider,
                note.title,
                noteSnippet,
                candidates.slice(0, 10),
                opts.abort
            )) {
                if (event.kind === 'error') {
                    throw new Error(event.message);
                }

                if (event.kind === 'done') {
                    finalAccepted = event.accepted;
                }
            }

            accepted = finalAccepted ?? [];
        } else {
            // Deterministic fallback: top-5 by hybrid score. Use the search
            // snippet (first ~140 chars) as the reason so the reader sees
            // *what* matched, not just *that* something matched.
            accepted = candidates.slice(0, 5).map((c) => ({
                title: c.title,
                reason: c.snippet?.slice(0, 140).trim() ?? '',
                score: c.score
            }));
        }

        const stripped = stripRelatedSection(note.content).trimEnd();
        const next = `${stripped}\n${renderRelatedSection(accepted)}`;

        const written = await this.vault.write({
            path: id,
            content: next,
            frontmatter: note.frontmatter
        }, {message: `synaipse: relink ${id}`});

        await this.maybeIndexNote(written);
        this.fulltextIndex.addNote(written);
        this.cache.set(written.id, {hash: written.hash, mtime: written.mtime});
        await this.cache.flush();

        return {noteId: written.id, accepted, skipped: false};
    }

    public async clipPage(input: {
        url: string;
        title: string;
        markdown: string;
        tags?: readonly string[];
        excerpt?: string;
    }): Promise<{noteId: NoteId; isUpdate: boolean}> {
        // Idempotency by URL: scan vault for an existing clip with the same source URL.
        let existingId: NoteId | undefined;

        for (const note of this.vault.list()) {
            if (note.frontmatter.source_url === input.url) {
                existingId = note.id;
                break;
            }
        }

        const now = new Date();
        const date = now.toISOString().slice(0, 10);
        const slug = slugifyForPath(input.title);
        const writePath = existingId ?? `Clipped/${date}-${slug}.md`;

        const frontmatter: Record<string, unknown> = {
            title: input.title,
            source_url: input.url,
            source: 'web-clipper',
            created: date,
            updated: date,
            tags: [...new Set(['clipped', ...(input.tags ?? [])])]
        };

        if (input.excerpt !== undefined && input.excerpt.length > 0) {
            frontmatter.excerpt = input.excerpt;
        }

        const body = `# ${input.title}\n\n> Source: <${input.url}>\n\n${input.markdown.trim()}\n`;

        const note = await this.vault.write(
            {path: writePath, content: body, frontmatter},
            {message: `synaipse: clip ${writePath}`}
        );

        await this.maybeIndexNote(note);
        this.fulltextIndex.addNote(note);
        this.cache.set(note.id, {hash: note.hash, mtime: note.mtime});
        await this.cache.flush();

        return {noteId: note.id, isUpdate: existingId !== undefined};
    }

    public async importChatgptConversation(
        conv: ChatgptImportConversation
    ): Promise<{noteId: NoteId; isUpdate: boolean}> {
        const existingMap = this.listChatgptImports();
        const existingId = existingMap.get(conv.id);

        const writePath = existingId ?? `chatgpt-import/${conv.id}/${slugifyForPath(conv.title)}.md`;

        const pointerToRelative = new Map<string, string>();

        for (const att of conv.attachments) {
            const buf = Buffer.from(att.dataBase64, 'base64');
            const result = await this.writeNoteAsset(writePath, buf, att.mimeType);
            pointerToRelative.set(att.assetPointer, result.relativePath);
        }

        const rendered = renderChatgptConversation(conv, (ptr) => pointerToRelative.get(ptr) ?? null);

        const note = await this.vault.write(
            {
                path: writePath,
                content: rendered.content,
                frontmatter: rendered.frontmatter
            },
            {message: `synaipse: import_chatgpt ${writePath}`}
        );

        await this.maybeIndexNote(note);
        this.fulltextIndex.addNote(note);
        this.cache.set(note.id, {hash: note.hash, mtime: note.mtime});
        await this.cache.flush();

        return {noteId: note.id, isUpdate: existingId !== undefined};
    }

    public async deleteNote(id: NoteId, opts?: ProjectOpts): Promise<void> {
        this.assertInProject(id, 'delete_note', opts?.project);

        const project = opts?.project ?? this.project;
        await this.vault.delete(id, {
            message: buildCommitMessage('delete_note', id, project),
            ...(opts?.gitAuthor !== undefined ? {author: opts.gitAuthor} : {})
        });

        if (this.index !== null) {
            await this.index.deleteNote(id);
        }

        this.fulltextIndex.removeNote(id);
        this.cache.delete(id);
        this.invalidateTopologyCaches();
    }

    // -- chat sessions ------------------------------------------------------
    //
    // Chats are deliberately NOT vault notes. They live in their own on-disk
    // store managed by ChatRepo so they don't pollute the notes list, the
    // graph, or any search index. Promoting a chat into a real vault note is
    // an explicit user action — see saveChatAsNote().

    public async listChats(): Promise<ChatSummary[]> {
        return this.chatRepo.list();
    }

    public async getChat(id: string): Promise<ChatSession> {
        return this.chatRepo.get(id);
    }

    public async createChat(
        input: {title: string; lastModel?: string; turns: ChatTurn[]}
    ): Promise<ChatSession> {
        const now = new Date();
        const baseId = buildChatId(input.title, now);
        const id = this.chatRepo.uniqueId(baseId);
        const iso = now.toISOString();

        const session: ChatSession = {
            id,
            title: input.title,
            createdAt: iso,
            updatedAt: iso,
            turns: input.turns
        };
        if (input.lastModel !== undefined) session.lastModel = input.lastModel;

        await this.chatRepo.write(session);
        return session;
    }

    public async updateChat(
        id: string,
        input: {title: string; lastModel?: string; turns: ChatTurn[]}
    ): Promise<ChatSession> {
        const prior = await this.chatRepo.tryGet(id);
        if (prior === null) throw new Error(`chat not found: ${id}`);

        const session: ChatSession = {
            id,
            title: input.title,
            createdAt: prior.createdAt,
            updatedAt: new Date().toISOString(),
            turns: input.turns
        };
        if (input.lastModel !== undefined) session.lastModel = input.lastModel;

        await this.chatRepo.write(session);
        return session;
    }

    public async deleteChat(id: string): Promise<void> {
        await this.chatRepo.delete(id);
    }

    /**
     * Promote a stored chat session into a real vault note. This is the
     * explicit "Save as Note" path — the source chat stays in the chat
     * store, and a copy lands in the vault where it can be searched,
     * linked, and graphed like any other note. The new note gets a
     * normal `kind: note` frontmatter so it won't be filtered out
     * anywhere.
     */
    public async saveChatAsNote(id: string, opts?: ProjectOpts): Promise<NoteId> {
        const session = await this.chatRepo.get(id);
        const {content, frontmatter} = serializeChatSession(session);

        // Override kind so the saved note is a regular note, not a chat
        // (the chat store is the source of truth for chats).
        const noteFrontmatter: Frontmatter = {
            ...frontmatter,
            kind: 'note',
            tags: Array.isArray(frontmatter.tags)
                ? [...frontmatter.tags.filter((t) => t !== 'chat'), 'chat-saved']
                : ['chat-saved']
        };

        // Use the chat id (filename) as the note path, but under a
        // dedicated vault folder so saved chats stay grouped.
        const notePath = `Chats/${session.id}`;
        const note = await this.writeNote(
            {path: notePath, content, frontmatter: noteFrontmatter},
            opts ?? {},
            'chat_save_as_note'
        );

        return note.id;
    }

    /**
     * One-shot migration: pre-refactor chats accidentally lived inside the
     * vault as `Chats/*.md` with `kind: chat`. Move them into the proper
     * chat store dir and delete the vault copies so they stop polluting
     * the notes list / graph / index.
     */
    public async migrateLegacyChatNotesOut(): Promise<{moved: number; failed: number}> {
        const legacy: NoteId[] = [];
        for (const note of this.vault.list()) {
            if (isChatNote(note)) legacy.push(note.id);
        }

        let moved = 0;
        let failed = 0;

        for (const noteId of legacy) {
            const note = this.vault.tryGet(noteId);
            if (note === undefined) continue;

            try {
                const session = parseChatSession(note);
                // Strip the "Chats/" prefix from the id so the chat store
                // uses a flat filename.
                const flatId = session.id.startsWith('Chats/')
                    ? session.id.slice('Chats/'.length)
                    : session.id;
                const safeId = this.chatRepo.uniqueId(flatId);
                await this.chatRepo.write({...session, id: safeId});

                // Remove from vault + bookkeeping
                await this.vault.delete(noteId, {message: `synaipse: migrate chat ${noteId} → chat store`});
                if (this.index !== null) await this.index.deleteNote(noteId);
                this.fulltextIndex.removeNote(noteId);
                this.cache.delete(noteId);

                moved += 1;
            } catch (cause) {
                process.stderr.write(`[synaipse] chat migration failed for ${noteId}: ${String(cause)}\n`);
                failed += 1;
            }
        }

        if (moved > 0) {
            process.stderr.write(`[synaipse] migrated ${moved} legacy chat note${moved === 1 ? '' : 's'} out of the vault into the chat store\n`);
        }

        return {moved, failed};
    }

    public async appendSessionLog(summary: string, references: string[], opts?: ProjectOpts): Promise<NoteId> {
        const project = this.requireProject('log_session', opts?.project);
        const now = new Date();
        const date = now.toISOString().slice(0, 10);
        const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        const sessionPath = `${this.projectFolder(project)}sessions/${date}.md`;
        const existing = this.vault.tryGet(sessionPath);

        const baseFrontmatter = existing !== undefined
            ? {...existing.frontmatter, updated: date}
            : {title: `Session ${date}`, tags: ['session', 'log'], created: date, updated: date};

        const refsLine = references.length > 0
            ? `\n\n**References:** ${references.map((r) => `[[${r}]]`).join(' · ')}`
            : '';

        const newEntry = `## ${time}\n\n${summary.trim()}${refsLine}\n`;

        const prevBody = (existing?.content ?? '').trimEnd();
        const body = prevBody.length === 0 ? newEntry : `${prevBody}\n\n${newEntry}`;

        const note = await this.writeNote(
            {path: sessionPath, content: body, frontmatter: baseFrontmatter},
            opts,
            'log_session'
        );

        return note.id;
    }

    public async appendInboxEntry(text: string, tags: string[], opts?: ProjectOpts): Promise<NoteId> {
        const project = this.requireProject('remember', opts?.project);
        const trimmed = text.trim();

        if (trimmed.length === 0) {
            throw new Error('remember: text must not be empty');
        }

        const now = new Date();
        const date = now.toISOString().slice(0, 10);
        const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        const inboxPath = `${this.projectFolder(project)}inbox/${date}.md`;
        const existing = this.vault.tryGet(inboxPath);

        const baseFrontmatter = existing !== undefined
            ? {...existing.frontmatter, updated: date}
            : {title: `Inbox ${date}`, tags: ['inbox'], created: date, updated: date};

        const cleanTags = tags
            .map((t) => t.trim().replace(/^#/, ''))
            .filter((t) => t.length > 0);
        const tagsLine = cleanTags.length > 0
            ? `\n\n${cleanTags.map((t) => `#${t}`).join(' ')}`
            : '';

        const newEntry = `### ${time}\n\n${trimmed}${tagsLine}\n`;

        const prevBody = (existing?.content ?? '').trimEnd();
        const body = prevBody.length === 0 ? newEntry : `${prevBody}\n\n${newEntry}`;

        const note = await this.writeNote(
            {path: inboxPath, content: body, frontmatter: baseFrontmatter},
            opts,
            'remember'
        );

        return note.id;
    }

    public readNote(id: NoteId): Note {
        const note = this.vault.get(id);
        this.touchAccess(note);
        return note;
    }

    public listNotes(): Note[] {
        return this.vault.list();
    }

    public tags(): Map<string, NoteId[]> {
        return this.vault.tags();
    }

    public backlinks(id: NoteId): NoteId[] {
        this.touchAccess(id);
        return this.vault.backlinksOf(id);
    }

    private touchAccess(noteOrId: Note | NoteId): void {
        if (typeof noteOrId === 'string') {
            const note = this.vault.tryGet(noteOrId);

            if (note === undefined) {
                return;
            }

            this.cache.touch(note.id, {hash: note.hash, mtime: note.mtime});
            return;
        }

        this.cache.touch(noteOrId.id, {hash: noteOrId.hash, mtime: noteOrId.mtime});
    }

    public staleNotes(opts: StaleNotesOptions = {}, now: number = Date.now()): StaleNote[] {
        const olderThanDays = opts.olderThanDays ?? 90;
        const pathPrefix = opts.pathPrefix ?? '';
        const limit = opts.limit ?? 100;
        const thresholdMs = olderThanDays * MS_PER_DAY;

        const result: StaleNote[] = [];

        for (const note of this.vault.list()) {
            if (pathPrefix.length > 0 && !note.id.startsWith(pathPrefix)) {
                continue;
            }

            const entry = this.cache.get(note.id);
            const lastAccessed = entry?.lastAccessed;
            const accessCount = entry?.accessCount ?? 0;

            const effective = lastAccessed !== undefined
                ? Math.max(note.mtime, lastAccessed)
                : note.mtime;

            const ageMs = now - effective;

            if (ageMs < thresholdMs) {
                continue;
            }

            result.push({
                id: note.id,
                title: note.title,
                tags: note.tags,
                mtime: note.mtime,
                ...(lastAccessed !== undefined ? {lastAccessed} : {}),
                accessCount,
                ageDays: Math.floor(ageMs / MS_PER_DAY)
            });
        }

        return result.sort((a, b) => b.ageDays - a.ageDays).slice(0, limit);
    }

    public onVaultChange(listener: VaultChangeListener): () => void {
        this.vaultChangeListeners.add(listener);
        return () => {
            this.vaultChangeListeners.delete(listener);
        };
    }

    public graph(): Graph {
        if (this.cachedGraph !== null) return this.cachedGraph;

        const notes = this.vault.list();
        const titleToId = new Map(notes.map((n) => [n.title, n.id]));

        const built: Graph = {
            nodes: notes.map((n) => ({id: n.id, title: n.title, tags: n.tags})),
            edges: notes.flatMap((n) =>
                n.wikilinks
                    .map((link) => titleToId.get(link))
                    .filter((target): target is NoteId => Boolean(target))
                    .map((target) => ({from: n.id, to: target, kind: 'wikilink' as const}))
            )
        };

        this.cachedGraph = built;
        return built;
    }

    public graphLayout(): GraphLayout {
        const data = this.graph();
        const cacheKey = `${data.nodes.length}:${data.edges.length}`;

        if (this.cachedLayout !== null && this.cachedLayoutKey === cacheKey) {
            return this.cachedLayout;
        }

        const layout = computeLayout(data);
        this.cachedLayout = layout;
        this.cachedLayoutKey = cacheKey;
        return layout;
    }

    public async related(id: NoteId, limit = 10): Promise<RelatedNote[]> {
        const note = this.vault.tryGet(id);

        if (note === undefined) {
            return [];
        }

        this.touchAccess(note);

        const accumulator = new Map<NoteId, {score: number; reasons: Set<string>}>();

        const add = (otherId: NoteId, weight: number, reason: string): void => {
            if (otherId === id || weight <= 0) {
                return;
            }

            const entry = accumulator.get(otherId) ?? {score: 0, reasons: new Set<string>()};
            entry.score += weight;
            entry.reasons.add(reason);
            accumulator.set(otherId, entry);
        };

        if (this.index !== null && note.content.length > 0) {
            const sample = note.content.slice(0, SEMANTIC_SAMPLE_CHARS);
            const hits = await this.index.semanticSearch(sample, limit * 2);

            for (const hit of hits) {
                add(hit.noteId, hit.score, 'semantic');
            }
        }

        const titleToId = new Map<string, NoteId>();
        for (const other of this.vault.list()) {
            titleToId.set(other.title, other.id);
        }

        for (const link of note.wikilinks) {
            const targetId = titleToId.get(link);

            if (targetId !== undefined) {
                add(targetId, 0.6, 'wikilink-out');
            }
        }

        for (const backlinkId of this.backlinks(id)) {
            add(backlinkId, 0.6, 'wikilink-in');
        }

        const myTags = new Set(note.tags);

        if (myTags.size > 0) {
            for (const other of this.vault.list()) {
                if (other.id === id) {
                    continue;
                }

                const shared = other.tags.filter((t) => myTags.has(t));

                if (shared.length === 0) {
                    continue;
                }

                if (shared.length >= 2) {
                    add(other.id, shared.length * 0.25, `tags:${shared.join(',')}`);
                } else {
                    add(other.id, 0.12, `tag:${shared[0] ?? ''}`);
                }
            }
        }

        return [...accumulator.entries()]
            .map(([otherId, {score, reasons}]) => {
                const other = this.vault.tryGet(otherId);
                return {
                    id: otherId,
                    title: other?.title ?? otherId,
                    score,
                    reasons: [...reasons]
                };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    public async suggestLinks(opts: SuggestLinksOptions = {}): Promise<LinkSuggestion[]> {
        const limit = opts.limit ?? 20;
        const minScore = opts.minScore ?? 0.65;
        const prefix = opts.pathPrefix ?? '';

        const allNotes = this.vault.list();
        const scoped = prefix.length === 0
            ? allNotes
            : allNotes.filter((n) => n.id.startsWith(prefix));

        if (scoped.length < 2) {
            return [];
        }

        const titleToId = new Map<string, NoteId>();
        for (const note of allNotes) {
            titleToId.set(note.title, note.id);
        }

        const linkedSet = (note: Note): Set<NoteId> => {
            const set = new Set<NoteId>([note.id]);

            for (const link of note.wikilinks) {
                const targetId = titleToId.get(link);

                if (targetId !== undefined) {
                    set.add(targetId);
                }
            }

            for (const backlinkId of this.vault.backlinksOf(note.id)) {
                set.add(backlinkId);
            }

            return set;
        };

        const suggestions = new Map<string, LinkSuggestion>();
        const pairKey = (x: NoteId, y: NoteId): string => x < y ? `${x}|${y}` : `${y}|${x}`;

        const recordPair = (
            aId: NoteId,
            bId: NoteId,
            score: number,
            reason: string,
            sharedTags?: string[]
        ): void => {
            const a = this.vault.tryGet(aId);
            const b = this.vault.tryGet(bId);

            if (a === undefined || b === undefined) {
                return;
            }

            const key = pairKey(aId, bId);
            const existing = suggestions.get(key);

            if (existing !== undefined) {
                if (score > existing.score) {
                    existing.score = score;
                }

                if (!existing.reasons.includes(reason)) {
                    existing.reasons.push(reason);
                }

                if (sharedTags !== undefined && existing.sharedTags === undefined) {
                    existing.sharedTags = sharedTags;
                }

                return;
            }

            suggestions.set(key, {
                a: aId,
                aTitle: a.title,
                b: bId,
                bTitle: b.title,
                score,
                reasons: [reason],
                ...(sharedTags !== undefined ? {sharedTags} : {})
            });
        };

        if (this.index !== null) {
            for (const note of scoped) {
                if (note.content.length === 0) {
                    continue;
                }

                const linked = linkedSet(note);
                const sample = note.content.slice(0, SEMANTIC_SAMPLE_CHARS);
                const hits = await this.index.semanticSearch(sample, 20);
                const seen = new Set<NoteId>();

                for (const hit of hits) {
                    if (seen.has(hit.noteId)) {
                        continue;
                    }

                    seen.add(hit.noteId);

                    if (linked.has(hit.noteId)) {
                        continue;
                    }

                    if (hit.score < minScore) {
                        continue;
                    }

                    if (prefix.length > 0 && !hit.noteId.startsWith(prefix)) {
                        continue;
                    }

                    recordPair(note.id, hit.noteId, hit.score, 'semantic');
                }
            }
        }

        for (let i = 0; i < scoped.length; i++) {
            const a = scoped[i];

            if (a === undefined || a.tags.length < 2) {
                continue;
            }

            const aLinked = linkedSet(a);
            const aTagSet = new Set(a.tags);

            for (let j = i + 1; j < scoped.length; j++) {
                const b = scoped[j];

                if (b === undefined || aLinked.has(b.id)) {
                    continue;
                }

                const shared = b.tags.filter((t) => aTagSet.has(t));

                if (shared.length < 2) {
                    continue;
                }

                const score = Math.min(0.95, 0.5 + 0.1 * shared.length);
                recordPair(a.id, b.id, score, 'tag-overlap', shared);
            }
        }

        return [...suggestions.values()]
            .sort((x, y) => y.score - x.score)
            .slice(0, limit);
    }

    public todos(pathPrefix = '', includeDone = false): TodoItem[] {
        const result: TodoItem[] = [];

        for (const note of this.vault.list()) {
            if (pathPrefix.length > 0 && !note.id.startsWith(pathPrefix)) {
                continue;
            }

            const lines = note.content.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i] ?? '';
                const match = TODO_REGEX.exec(line);

                if (match === null) {
                    continue;
                }

                const done = match[1] !== ' ';

                if (done && !includeDone) {
                    continue;
                }

                result.push({
                    noteId: note.id,
                    title: note.title,
                    line: i + 1,
                    text: (match[2] ?? '').trim(),
                    done
                });
            }
        }

        return result;
    }

    public async prime(opts: PrimeOptions = {}): Promise<PrimeResult> {
        const project = this.getProject(opts.project ?? null);
        const limit = Math.max(1, opts.limit ?? 15);
        const topic = (opts.topic ?? '').trim();
        const includeCrawler = opts.includeCrawler === true;

        const projectPrefix = project === null ? null : `Memory/${project}/`;
        const sessionPrefix = project === null ? 'Memory/sessions/' : `Memory/${project}/sessions/`;
        const decisionPrefix = project === null ? 'Memory/decisions/' : `Memory/${project}/decisions/`;

        const all = this.vault.list();

        const isCrawler = (note: Note): boolean => note.id.startsWith('Crawler/');

        const inProject = (note: Note): boolean => {
            if (projectPrefix === null) return true;
            if (note.id.startsWith(projectPrefix)) return true;
            if (note.frontmatter['project'] === project) return true;
            if (note.tags.includes(`project/${project}`)) return true;
            return false;
        };

        const seen = new Set<NoteId>();
        const context: PrimerEntry[] = [];

        const push = (note: Note, reason: PrimerReason): void => {
            if (seen.has(note.id)) return;
            seen.add(note.id);
            context.push({
                id: note.id,
                title: note.title,
                reason,
                excerpt: extractExcerpt(note.content, 240),
                tags: note.tags,
                mtime: note.mtime,
                backlinkCount: note.backlinks.length
            });
        };

        for (const note of all) {
            if (note.frontmatter['prime'] === true || note.frontmatter['pinned'] === true) {
                push(note, 'pinned');
            }
        }

        const sessions = all
            .filter((n) => n.id.startsWith(sessionPrefix))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 2);
        for (const n of sessions) {
            if (context.length >= limit) break;
            push(n, 'recent_session');
        }

        const decisions = all
            .filter((n) => n.id.startsWith(decisionPrefix))
            .sort((a, b) => b.mtime - a.mtime);
        for (const n of decisions) {
            if (context.length >= limit) break;
            push(n, 'project_decision');
        }

        if (topic.length > 0) {
            // Topic always passes Crawler through — if the user asked for a topic
            // explicitly, they want hits. Filtering Crawler here would silently drop
            // legitimate code-crawler results (e.g. Crawler/code/<project>/...).
            const hits = await this.search(topic, 'hybrid', 5);
            for (const hit of hits) {
                if (context.length >= limit) break;
                const note = this.vault.tryGet(hit.noteId);
                if (note === undefined) continue;
                if (!inProject(note)) continue;
                push(note, 'topic');
            }
        }

        const projectNotes = all.filter((n) => inProject(n) && (includeCrawler || !isCrawler(n)));

        const hot = [...projectNotes]
            .filter((n) => n.backlinks.length > 0)
            .sort((a, b) => b.backlinks.length - a.backlinks.length)
            .slice(0, 3);
        for (const n of hot) {
            if (context.length >= limit) break;
            push(n, 'hot');
        }

        const cutoff = Date.now() - 14 * MS_PER_DAY;
        const recent = [...projectNotes]
            .filter((n) => n.mtime >= cutoff)
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 5);
        for (const n of recent) {
            if (context.length >= limit) break;
            push(n, 'recent');
        }

        const todoPrefix = projectPrefix ?? '';
        const todoSource = this.todos(todoPrefix, false);
        const allTodos = includeCrawler ? todoSource : todoSource.filter((t) => !t.noteId.startsWith('Crawler/'));

        const todoSample = allTodos.slice(0, 3);
        const payloadChars = JSON.stringify({context, todoSample}).length;

        return {
            project,
            todoCount: allTodos.length,
            todoSample,
            context,
            tokenEstimate: Math.ceil(payloadChars / 4)
        };
    }

    public async linkNote(fromId: NoteId, toTitles: readonly string[], section = 'References', opts?: ProjectOpts): Promise<{note: Note; added: string[]}> {
        this.assertInProject(fromId, 'link_note', opts?.project);
        const note = this.vault.get(fromId);
        const targets = toTitles.map((t) => t.trim()).filter((t) => t.length > 0);

        if (targets.length === 0) {
            return {note, added: []};
        }

        const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const headingPattern = new RegExp(`^##\\s+${escapedSection}\\s*$`);
        const lines = note.content.split('\n');

        let sectionStart = -1;
        let sectionEnd = lines.length;

        for (let i = 0; i < lines.length; i++) {
            if (headingPattern.test(lines[i] ?? '')) {
                sectionStart = i;

                for (let j = i + 1; j < lines.length; j++) {
                    if (/^##\s/.test(lines[j] ?? '')) {
                        sectionEnd = j;
                        break;
                    }
                }
                break;
            }
        }

        let body: string;
        let added: string[];

        if (sectionStart === -1) {
            added = [...targets];
            const insertion = added.map((t) => `- [[${t}]]`).join('\n');
            const trimmed = note.content.replace(/\s+$/, '');
            const sep = trimmed.length === 0 ? '' : '\n\n';
            body = `${trimmed}${sep}## ${section}\n\n${insertion}\n`;
        } else {
            const sectionLines = lines.slice(sectionStart, sectionEnd);
            const existing = new Set<string>();
            const linkPattern = /\[\[([^\]]+)\]\]/g;

            for (const ln of sectionLines) {
                let match: RegExpExecArray | null;

                while ((match = linkPattern.exec(ln)) !== null) {
                    existing.add(match[1] ?? '');
                }
            }

            added = targets.filter((t) => !existing.has(t));

            if (added.length === 0) {
                return {note, added: []};
            }

            const insertion = added.map((t) => `- [[${t}]]`);
            const newLines = [...lines.slice(0, sectionEnd), ...insertion, ...lines.slice(sectionEnd)];
            body = newLines.join('\n');
        }

        const updated = await this.writeNote(
            {path: note.id, content: body, frontmatter: note.frontmatter},
            opts,
            'link_note'
        );

        return {note: updated, added};
    }

    public async updateNote(id: NoteId, patch: UpdateNoteInput, opts?: ProjectOpts): Promise<Note> {
        this.assertInProject(id, 'update_note', opts?.project);
        const existing = this.vault.get(id);
        const nextContent = patch.content ?? existing.content;
        const nextFrontmatter = patch.frontmatterPatch === undefined
            ? existing.frontmatter
            : {...existing.frontmatter, ...patch.frontmatterPatch};

        return this.writeNote(
            {path: existing.id, content: nextContent, frontmatter: nextFrontmatter},
            opts,
            'update_note'
        );
    }

    private attachWatcher(): void {
        this.watcher.on('event', (event) => {
            this.handleEvent(event.kind, event.path).catch((error: unknown) => {
                process.stderr.write(`[synaipse] watcher error: ${String(error)}\n`);
            });
        });

        this.watcher.start();
    }

    private async handleEvent(kind: 'created' | 'updated' | 'deleted', path: string): Promise<void> {
        await this.vault.handleExternalChange(path, kind);
        const id = this.idFromPath(path);

        if (kind === 'deleted') {
            if (this.index !== null) {
                await this.index.deleteNote(id);
            }
            this.fulltextIndex.removeNote(id);
            this.cache.delete(id);
            this.notifyVaultChange({kind, path, noteId: id});
            return;
        }

        const note = this.vault.tryGet(id);

        if (!note) {
            return;
        }

        // Pick up cache updates from a parallel CLI process so we don't
        // re-embed a file that the relink/compile CLI just wrote.
        await this.cache.reloadIfChanged();

        const cached = this.cache.get(id);

        if (cached && cached.hash === note.hash) {
            return;
        }

        await this.maybeIndexNote(note);
        this.fulltextIndex.addNote(note);
        this.cache.set(id, {hash: note.hash, mtime: note.mtime});
        this.notifyVaultChange({kind, path, noteId: id});
    }

    private notifyVaultChange(event: VaultEvent & {noteId: NoteId}): void {
        for (const listener of this.vaultChangeListeners) {
            try {
                listener(event);
            } catch (error) {
                process.stderr.write(`[synaipse] vault-change listener error: ${String(error)}\n`);
            }
        }
    }

    private idFromPath(absolutePath: string): NoteId {
        return absolutePath
            .replace(this.vault.root, '')
            .replace(/^[\\/]/, '')
            .replaceAll('\\', '/');
    }

}