import path from 'node:path';
import type {BenchmarkSet, BenchmarkSummary, CanvasDocument, ChatAdapter, Config, ExternalNoteChange, Frontmatter, Graph, Note, NoteAdapter, NoteId, NoteWriteInput, Roadmap, RoadmapSummary, SearchHit, SearchMode, SearchScope, VaultEvent} from '@synaipse/core';
import {createLogger, parseRoadmap, ProjectScopeError} from '@synaipse/core';
import matter from 'gray-matter';
import {EntryStore, FilesystemNoteAdapter, MATTER_NO_CACHE, QueryVectorCache, Vault, VaultHistory, VaultWatcher, type History} from '@synaipse/vault';
import {createEmbedder, createReranker, embedderFingerprint, QdrantStore, VectorIndex, type Embedder, type Reranker, type VectorStore} from '@synaipse/vector';
import type {VerifyReport} from 'ngit';
import type {ActivityCommit, ActivityReport} from './Activity.js';
import type {WriteAssetResult} from './Assets.js';
import {FilesystemAssetStore, type AssetStore} from './AssetStore.js';
import {AuditLog, type AuditEntry} from './AuditLog.js';
import {benchmarkPathFor, benchmarkSetFromNote, benchmarkWriteInput, listBenchmarkSummaries, normalizeBenchmarks} from './Benchmark.js';
import {deleteCanvasFromVault, listCanvasesInVault, readCanvasFromVault, writeCanvasToVault, type CanvasSummary} from './Canvas.js';
import type {ChatEvent, ChatOptions, SummarizeEvent} from './Chat.js';
import type {ChatgptImportConversation} from './ChatgptImport.js';
import {ChatRepo} from './ChatRepo.js';
import type {ChatSession, ChatSummary, ChatTurn} from './ChatStore.js';
import type {CompileEvent} from './Compile.js';
import {ConsentStore, type ConsentDecision, type ConsentRequest} from './ConsentStore.js';
import type {DuplicateCandidate, DuplicateText} from './Duplicates.js';
import {FilesystemChatAdapter} from './FilesystemChatAdapter.js';
import type {InboxEntry, SectionAnchor} from './Inbox.js';
import type {KnowledgeState} from './KnowledgeState.js';
import type {GraphLayout} from './Layout.js';
import {createLlmProvider, isLocalUrl, type LlmConfig, type LlmProvider, type LlmProviderKind} from './Llm.js';
import type {LocalGraph, LocalGraphOptions} from './LocalGraph.js';
import type {DecayOptions} from './MemoryDecay.js';
import type {AcceptedLink} from './Relink.js';
import {createWebSearchProvider, type ResearchEvent, type WebSearchConfig} from './Research.js';
import {listRoadmapSummaries, normalizeRoadmap, roadmapFromNote, roadmapPathFor, roadmapWriteInput} from './Roadmap.js';
import {AuditRecorder} from './Service/AuditRecorder.js';
import {ChatSessions} from './Service/ChatSessions.js';
import {GraphService} from './Service/GraphService.js';
import {HistoryService} from './Service/HistoryService.js';
import {ImportService} from './Service/ImportService.js';
import {InboxService} from './Service/InboxService.js';
import {LlmService} from './Service/LlmService.js';
import {MemoryService} from './Service/MemoryService.js';
import {NoteCore} from './Service/NoteCore.js';
import {NoteWriter} from './Service/NoteWriter.js';
import {ProjectScope} from './Service/ProjectScope.js';
import {SearchService} from './Service/SearchService.js';
import type {
    ArchiveReport,
    IndexingStats,
    InboxCandidate,
    InboxEntryRef,
    InboxTarget,
    LinkSuggestion,
    NoteHistoryEntry,
    PrimeOptions,
    PrimeResult,
    ProjectOpts,
    RelatedNote,
    RemovedNote,
    SearchFilter,
    SnapshotEntry,
    StaleNote,
    StaleNotesOptions,
    SuggestLinksOptions,
    TodoItem,
    UpdateNoteInput,
    VaultChangeListener,
    WriteGuard
} from './Service/Types.js';

export type * from './Service/Types.js';
export type {ChatEvent, ChatSource, ChatOptions, ChatMessage, ChatPrivacyStats, SummarizeEvent} from './Chat.js';
export type {RedactionHit, RedactionResult} from './Privacy.js';
export type {ChatSession, ChatSummary, ChatTurn, ChatSourceRef} from './ChatStore.js';
export type {WriteAssetResult} from './Assets.js';
export type {CanvasSummary} from './Canvas.js';
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

const log = createLogger('service');

const isInside = (dir: string, file: string): boolean => {
    const rel = path.relative(path.resolve(dir), path.resolve(file));
    return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
};

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

/**
 * Classify the embedder for audit-log routing. Same DSGVO posture as chat
 * providers: anything that hits a non-loopback URL is "external" and must
 * be auditable; in-process (huggingface) and ollama-on-loopback stay
 * silent. Voyage has no URL knob — always external.
 */
const embedderAuditInfo = (config: Config): {providerId: string | null; external: boolean} => {
    const provider = config.embeddings.provider;
    if (provider === 'voyage') return {providerId: 'voyage', external: true};
    if (provider === 'huggingface') return {providerId: 'huggingface', external: false};
    if (provider === 'ollama') return {providerId: 'ollama', external: config.ollama !== undefined && !isLocalUrl(config.ollama.url)};
    return {providerId: null, external: false};
};

/**
 * Dependency-injection seam for the Service. Local-Mode boots without
 * touching this — all defaults wrap the filesystem vault. Server-Mode
 * boot (in @synaipse/web-api or @synaipse/mcp-server) passes a bundle from
 * @synaipse/server-storage's createServerAdapters() plus a NoopHistory
 * from @synaipse/vault, and skips the chokidar watcher because there
 * is no filesystem vault to tail.
 */
export interface ServiceOverrides {
    notes?: NoteAdapter;
    chats?: ChatAdapter;
    history?: History;
    assetStore?: AssetStore;
    skipWatcher?: boolean;
    /**
     * Escape hatch for tests — inject a stub Reranker without spinning
     * up ONNX runtime. `null` explicitly disables reranking; omit
     * entirely to fall through to `createReranker(config)`.
     */
    reranker?: Reranker | null;
    /**
     * Test hooks for the embedding path: inject a fake embedder and an
     * in-memory vector store so start-up/write/retry behaviour can be
     * verified without Voyage/Ollama and Qdrant. `embedder: null`
     * disables embeddings regardless of config.
     */
    embedder?: Embedder | null;
    vectorStore?: VectorStore;
}

/**
 * The service layer behind the web API and the MCP server. A thin facade
 * (plan P7 / D2): it wires the parts in `Service/` and forwards to them.
 *
 * - {@link NoteCore}: notes, fulltext + vector index, topology caches
 * - {@link NoteWriter}: scoped/unscoped writes, guards, deletes
 * - {@link SearchService}, {@link GraphService}, {@link MemoryService},
 *   {@link InboxService}, {@link LlmService}, {@link ChatSessions},
 *   {@link HistoryService}, {@link ImportService}, {@link AuditRecorder}
 *
 * What stays here: construction, start/stop, the file watcher, and the
 * small vault-native features (canvas, roadmap, benchmarks, assets, consent).
 */
export class SynaipseService {
    /** Vault kept around for filesystem-specific concerns: root path, ngit repo handle, and file-watcher sync. Note payloads go through `core.notes` (a NoteAdapter) so a MariaDB implementation can drop in. */
    private readonly vault: Vault;
    private readonly assetStore: AssetStore;
    /** Query embeddings in state.db (local mode only); closed in stop(). */
    private queryVectors: QueryVectorCache | null = null;
    private readonly watcher: VaultWatcher;
    private readonly skipWatcher: boolean;
    private stopExternalChanges: (() => void) | null = null;
    /** Serialises applying changes from other processes (a reset reindexes asynchronously). */
    private externalQueue: Promise<void> = Promise.resolve();
    private readonly consentStore = new ConsentStore();
    private readonly vaultChangeListeners = new Set<VaultChangeListener>();

    private readonly core: NoteCore;
    private readonly scope: ProjectScope;
    private readonly writer: NoteWriter;
    private readonly audit: AuditRecorder;
    private readonly searchService: SearchService;
    private readonly graphService: GraphService;
    private readonly historyService: HistoryService;
    private readonly memory: MemoryService;
    private readonly inbox: InboxService;
    private readonly llm: LlmService;
    private readonly chatSessions: ChatSessions;
    private readonly imports: ImportService;

    public constructor(config: Config, overrides: ServiceOverrides = {}) {
        const git = config.git ?? {
            autoCommit: true,
            author: {name: 'Synaipse', email: 'synaipse@local'}
        };
        const statePath = config.statePath ?? path.join(config.vaultPath, '.synaipse', 'state.db');

        this.vault = new Vault(config.vaultPath, {
            history: {autoCommit: git.autoCommit, author: git.author}
        });
        const notes = overrides.notes ?? new FilesystemNoteAdapter(
            this.vault,
            new EntryStore(statePath, {
                legacyJsonPath: config.indexCachePath,
                // Never rename a file that belongs to another vault.
                renameLegacy: isInside(config.vaultPath, config.indexCachePath)
            })
        );
        const history = overrides.history ?? new VaultHistory(this.vault);
        this.assetStore = overrides.assetStore ?? new FilesystemAssetStore(this.vault.root);
        const chats = overrides.chats ?? new FilesystemChatAdapter(new ChatRepo(config.chatStoreDir));
        this.watcher = new VaultWatcher(config.vaultPath);
        this.skipWatcher = overrides.skipWatcher ?? false;

        const chatProvider: LlmProvider | null = config.chat !== undefined
            ? createLlmProvider(toLlmConfig(config.chat))
            : null;
        const researchProvider = config.research !== undefined
            ? createWebSearchProvider(toWebSearchConfig(config.research))
            : null;

        const embedder = overrides.embedder !== undefined ? overrides.embedder : createEmbedder(config);
        let index: VectorIndex | null = null;
        let embedModel: string | null = null;

        if (embedder !== null) {
            embedModel = embedderFingerprint(config, embedder.dimension) ?? `custom:${embedder.dimension}`;

            const store = overrides.vectorStore ?? new QdrantStore({
                url: config.qdrant.url,
                ...(config.qdrant.apiKey !== undefined ? {apiKey: config.qdrant.apiKey} : {}),
                collection: config.qdrant.collection,
                dimension: embedder.dimension,
                retry: {
                    onRetry: ({attempt, error, waitMs}) => {
                        const reason = error instanceof Error ? error.message : String(error);
                        log.warn('qdrant retry', {attempt, reason, waitMs});
                    }
                }
            });

            // Second-level query cache in state.db (plan P4 / A4). Local mode
            // only: with a notes override (server mode) there is no vault-local
            // state file to share.
            if (overrides.notes === undefined) {
                try {
                    this.queryVectors = new QueryVectorCache(statePath);
                } catch (error) {
                    log.warn('persistent query cache unavailable; in-memory only', {error});
                }
            }

            index = new VectorIndex({
                embedder,
                store,
                fingerprint: embedModel,
                ...(this.queryVectors !== null ? {persistentQueryCache: this.queryVectors} : {}),
                onBatch: ({batch, batches, chunks, chars}) => {
                    log.debug('embed batch', {batch, batches, chunks, chars});
                },
                onOversize: (chunk) => {
                    log.warn('oversize chunk — tune CHUNK_DEFAULTS', {chunk: chunk.id, chars: chunk.text.length});
                }
            });
        }

        this.core = new NoteCore({notes, index, embedModel, embedExcludePrefixes: config.embedExcludePrefixes ?? []});
        this.scope = new ProjectScope(config.project?.name ?? null, config.project?.extraTags ?? []);
        this.writer = new NoteWriter(this.core, this.scope);
        this.audit = new AuditRecorder(new AuditLog(config.auditLogPath), chatProvider, embedderAuditInfo(config));
        this.searchService = new SearchService(this.core, this.audit, overrides.reranker ?? createReranker(config), config.reranker?.topN ?? 30);
        // Registers its layout hook on the core before anyone else can listen.
        this.graphService = new GraphService(this.core, this.audit);
        this.historyService = new HistoryService(history, notes);
        this.memory = new MemoryService(this.core, this.writer, this.searchService, this.scope);
        this.inbox = new InboxService(this.core, this.writer, this.searchService, this.scope);
        this.llm = new LlmService(this.core, this.searchService, this.writer, this.audit, chatProvider, researchProvider);
        this.chatSessions = new ChatSessions(chats, this.core, this.writer);
        this.imports = new ImportService(notes, this.writer, this.assetStore);
    }

    private get notes(): NoteAdapter {
        return this.core.notes;
    }

    // --- lifecycle ---------------------------------------------------------

    public async start(): Promise<void> {
        await this.notes.load();
        await this.chatSessions.load();

        // Migrate any chats that ended up in the vault during the brief
        // window where the chat layer was vault-backed. After this runs
        // once, the vault is chat-free and the chat store is the sole
        // home for conversations.
        await this.chatSessions.migrateLegacyNotesOut();

        await this.core.indexAll();
        this.attachWatcher();
        this.graphService.warm();
    }

    public async stop(): Promise<void> {
        await this.graphService.close();
        await this.watcher.stop();
        this.stopExternalChanges?.();
        this.stopExternalChanges = null;
        await this.externalQueue;
        await this.notes.flushEntries();
        this.notes.closeLocal?.();
        this.queryVectors?.close();
        this.queryVectors = null;
    }

    public getLastIndexingStats(): IndexingStats {
        return this.core.stats();
    }

    public getVault(): Vault {
        return this.vault;
    }

    public hasSemanticIndex(): boolean {
        return this.core.index !== null;
    }

    /** Run many writes as one unit: one commit, embeddings in groups at the end (see NoteCore.batch). */
    public async batch<T>(fn: () => Promise<T>, opts: {message?: string; author?: {name: string; email: string}} = {}): Promise<T> {
        return this.core.batch(fn, opts);
    }

    // --- notes -------------------------------------------------------------

    public readNote(id: NoteId): Note {
        const note = this.notes.get(id);
        this.core.touchAccess(note);
        return note;
    }

    /** Non-throwing, and does NOT record access (for auxiliary lookups such as consent filtering). */
    public tryReadNote(id: NoteId): Note | undefined {
        return this.notes.tryGet(id);
    }

    public listNotes(): Note[] {
        return this.notes.list();
    }

    public tags(): Map<string, NoteId[]> {
        return this.notes.tags();
    }

    public backlinks(id: NoteId): NoteId[] {
        return this.core.backlinks(id);
    }

    /** How current a note is (plan P8 / B4); null for an unknown id. */
    public knowledgeState(id: NoteId): KnowledgeState | null {
        return this.core.knowledgeState(id);
    }

    /** Wikilink targets of `note` that resolve to no note (same rule as graph/backlinks). */
    public unresolvedWikilinks(note: Pick<Note, 'wikilinks'>): string[] {
        return this.core.unresolvedWikilinks(note);
    }

    public getProject(override?: string | null): string | null {
        return this.scope.get(override);
    }

    public getConfigExtraTags(): readonly string[] {
        return this.scope.configExtraTags;
    }

    public async writeNote(input: NoteWriteInput & WriteGuard, opts?: ProjectOpts, commitTool = 'write_note'): Promise<Note> {
        return this.writer.writeNote(input, opts, commitTool);
    }

    public writePathFor(path: string, opts?: ProjectOpts): NoteId {
        return this.writer.writePathFor(path, opts);
    }

    /** Web UI only; MCP writers need {@link writeNote} for project-scope enforcement. */
    public async writeNoteUnscoped(input: NoteWriteInput, commitTool = 'write_note'): Promise<Note> {
        return this.writer.writeNoteUnscoped(input, commitTool);
    }

    public async updateNote(id: NoteId, patch: UpdateNoteInput, opts?: ProjectOpts): Promise<Note> {
        return this.writer.updateNote(id, patch, opts);
    }

    public async linkNote(fromId: NoteId, toTitles: readonly string[], section = 'References', opts?: ProjectOpts): Promise<{note: Note; added: string[]}> {
        return this.writer.linkNote(fromId, toTitles, section, opts);
    }

    public async deleteNote(id: NoteId, opts?: ProjectOpts): Promise<void> {
        return this.writer.deleteNote(id, opts);
    }

    public async deleteNoteUnscoped(id: NoteId): Promise<void> {
        return this.writer.deleteNoteUnscoped(id);
    }

    // --- search ------------------------------------------------------------

    /**
     * Search, optionally inside a path scope (applied inside every signal
     * before the cut to `limit`). An MCP token's path restriction is
     * added automatically.
     */
    public async search(query: string, mode: SearchMode, limit: number, scope?: SearchScope, filter?: SearchFilter): Promise<SearchHit[]> {
        return this.searchService.search(query, mode, limit, scope, filter);
    }

    public sectionFor(id: NoteId, query: string): SectionAnchor | null {
        return this.searchService.sectionFor(id, query);
    }

    public async possibleDuplicates(text: DuplicateText, exclude: readonly NoteId[] = []): Promise<DuplicateCandidate[]> {
        return this.searchService.possibleDuplicates(text, exclude);
    }

    // --- graph -------------------------------------------------------------

    /** Bumped on every write, delete and watcher change; equal versions mean an identical graph and note list. */
    public graphVersion(): number {
        return this.core.version();
    }

    /** Called synchronously after every change that bumps {@link graphVersion}. Listeners should debounce. */
    public onTopologyChange(listener: (version: number) => void): () => void {
        return this.core.onTopologyChange(listener);
    }

    public graph(): Graph {
        return this.core.graph();
    }

    public localGraph(id: NoteId, options: LocalGraphOptions = {}): LocalGraph | null {
        return this.graphService.localGraph(id, options);
    }

    public async graphLayout(): Promise<GraphLayout & {stale?: boolean}> {
        return this.graphService.graphLayout();
    }

    public async related(id: NoteId, limit = 10): Promise<RelatedNote[]> {
        return this.graphService.related(id, limit);
    }

    public async suggestLinks(opts: SuggestLinksOptions = {}): Promise<LinkSuggestion[]> {
        return this.graphService.suggestLinks(opts);
    }

    // --- memory ------------------------------------------------------------

    public async appendSessionLog(summary: string, references: string[], opts?: ProjectOpts): Promise<NoteId> {
        return this.memory.appendSessionLog(summary, references, opts);
    }

    public async appendInboxEntry(text: string, tags: string[], opts?: ProjectOpts): Promise<NoteId> {
        return this.memory.appendInboxEntry(text, tags, opts);
    }

    public async prime(opts: PrimeOptions = {}): Promise<PrimeResult> {
        return this.memory.prime(opts);
    }

    public todos(pathPrefix = '', includeDone = false): TodoItem[] {
        return this.memory.todos(pathPrefix, includeDone);
    }

    public staleNotes(opts: StaleNotesOptions = {}, now: number = Date.now()): StaleNote[] {
        return this.memory.staleNotes(opts, now);
    }

    public async archiveStaleNotes(opts: DecayOptions & {dryRun?: boolean} = {}, now: number = Date.now()): Promise<ArchiveReport> {
        return this.memory.archiveStaleNotes(opts, now);
    }

    // --- inbox -------------------------------------------------------------

    public listInboxes(): Array<{project: string; entries: number}> {
        return this.inbox.list();
    }

    public inboxEntries(project: string, opts: {sinceMs?: number} = {}): InboxEntry[] {
        return this.inbox.entries(project, opts);
    }

    public async discardInboxEntry(project: string, ref: InboxEntryRef): Promise<void> {
        return this.inbox.discard(project, ref);
    }

    public async promoteInboxEntry(project: string, ref: InboxEntryRef, target: InboxTarget, text?: string): Promise<Note> {
        return this.inbox.promote(project, ref, target, text);
    }

    public async inboxCandidates(project: string, opts: {sinceMs?: number; limit?: number} = {}): Promise<InboxCandidate[]> {
        return this.inbox.candidates(project, opts);
    }

    // --- history -----------------------------------------------------------

    public async historyEnabled(): Promise<boolean> {
        return this.historyService.historyEnabled();
    }

    public async verifyHistory(): Promise<VerifyReport | null> {
        return this.historyService.verifyHistory();
    }

    public async noteHistory(id: NoteId, limit = 50): Promise<NoteHistoryEntry[]> {
        return this.historyService.noteHistory(id, limit);
    }

    public async noteVersion(id: NoteId, commitSha: string): Promise<string> {
        return this.historyService.noteVersion(id, commitSha);
    }

    public async noteDiff(id: NoteId, fromSha: string, toSha?: string): Promise<string> {
        return this.historyService.noteDiff(id, fromSha, toSha);
    }

    public async getActivity(opts: {sinceDays?: number; limit?: number} = {}): Promise<ActivityReport> {
        return this.historyService.getActivity(opts);
    }

    public async activityCommits(opts: {limit: number; before?: string}): Promise<{commits: ActivityCommit[]; next: string | null}> {
        return this.historyService.activityCommits(opts);
    }

    public async removedSince(sinceMs: number, limit = 200): Promise<RemovedNote[]> {
        return this.historyService.removedSince(sinceMs, limit);
    }

    public async snapshotList(commitSha: string, treePath?: string): Promise<SnapshotEntry[]> {
        return this.historyService.snapshotList(commitSha, treePath);
    }

    public async snapshotWalk(commitSha: string, pathPrefix = ''): Promise<{path: string; sha: string}[]> {
        return this.historyService.snapshotWalk(commitSha, pathPrefix);
    }

    // --- LLM ---------------------------------------------------------------

    public chatEnabled(): boolean {
        return this.llm.chatEnabled();
    }

    public getChatModel(): string | null {
        return this.llm.getChatModel();
    }

    public getChatProviderKind(): LlmProviderKind | null {
        return this.llm.getChatProviderKind();
    }

    public getChatProviderIsLocal(): boolean | null {
        return this.llm.getChatProviderIsLocal();
    }

    /** Exposed so other features (crawler-compile, deep-research) can borrow the configured LLM. */
    public getChatProvider(): LlmProvider | null {
        return this.llm.getChatProvider();
    }

    public noteFlags(note: Note): {private: boolean} {
        return this.llm.noteFlags(note);
    }

    public async chatPreview(options: ChatOptions): ReturnType<LlmService['chatPreview']> {
        return this.llm.chatPreview(options);
    }

    public chat(options: ChatOptions): AsyncGenerator<ChatEvent, void, void> {
        return this.llm.chat(options);
    }

    public summarizeNote(id: NoteId, opts: {abort?: AbortSignal; saveToFrontmatter?: boolean; projectOverride?: string | null} = {}): AsyncGenerator<SummarizeEvent, void, void> {
        return this.llm.summarizeNote(id, opts);
    }

    public compileNote(id: NoteId, opts: {abort?: AbortSignal; force?: boolean} = {}): AsyncGenerator<CompileEvent & {compiledPath?: NoteId}, void, void> {
        return this.llm.compileNote(id, opts);
    }

    public async relinkNote(id: NoteId, opts: Parameters<LlmService['relinkNote']>[1] = {}): Promise<{noteId: NoteId; accepted: AcceptedLink[]; skipped: boolean}> {
        return this.llm.relinkNote(id, opts);
    }

    public researchEnabled(): boolean {
        return this.llm.researchEnabled();
    }

    public getResearchProviderKind(): 'tavily' | 'searxng' | null {
        return this.llm.getResearchProviderKind();
    }

    public research(question: string, opts: {abort?: AbortSignal} = {}): AsyncGenerator<ResearchEvent, void, void> {
        return this.llm.research(question, opts);
    }

    // --- audit -------------------------------------------------------------

    public async getAuditEntries(opts: Parameters<AuditRecorder['entries']>[0] = {}): Promise<AuditEntry[]> {
        return this.audit.entries(opts);
    }

    public async getAuditPage(opts: Parameters<AuditLog['page']>[0]): Promise<{entries: AuditEntry[]; nextBeforeLine: number | null}> {
        return this.audit.page(opts);
    }

    public async getAuditCount(opts: {excludeKinds?: readonly AuditEntry['kind'][]} = {}): Promise<number> {
        return this.audit.count(opts);
    }

    // --- chat sessions -----------------------------------------------------

    public async listChats(): Promise<ChatSummary[]> {
        return this.chatSessions.list();
    }

    public async getChat(id: string): Promise<ChatSession> {
        return this.chatSessions.get(id);
    }

    public async createChat(input: {title: string; lastModel?: string; turns: ChatTurn[]}): Promise<ChatSession> {
        return this.chatSessions.create(input);
    }

    public async updateChat(id: string, input: {title: string; lastModel?: string; turns: ChatTurn[]}): Promise<ChatSession> {
        return this.chatSessions.update(id, input);
    }

    public async deleteChat(id: string): Promise<void> {
        return this.chatSessions.delete(id);
    }

    public async saveChatAsNote(id: string, opts?: ProjectOpts): Promise<NoteId> {
        return this.chatSessions.saveAsNote(id, opts);
    }

    public async migrateLegacyChatNotesOut(): Promise<{moved: number; failed: number}> {
        return this.chatSessions.migrateLegacyNotesOut();
    }

    // --- imports -----------------------------------------------------------

    public listChatgptImports(): Map<string, NoteId> {
        return this.imports.listChatgptImports();
    }

    public async clipPage(input: {url: string; title: string; markdown: string; tags?: readonly string[]; excerpt?: string}): Promise<{noteId: NoteId; isUpdate: boolean}> {
        return this.imports.clipPage(input);
    }

    public async importChatgptConversation(conv: ChatgptImportConversation): Promise<{noteId: NoteId; isUpdate: boolean}> {
        return this.imports.importChatgptConversation(conv);
    }

    // --- assets ------------------------------------------------------------

    public async writeNoteAsset(noteId: NoteId, content: Buffer, contentType: string | null): Promise<WriteAssetResult> {
        return this.assetStore.writeAsset({noteId, content, contentType});
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
        const project = this.scope.require('write_asset', opts?.project);
        const prefix = this.scope.folder(project);

        if (input.noteId !== undefined && input.noteId.length > 0) {
            if (!input.noteId.startsWith(prefix)) {
                throw new ProjectScopeError(
                    `write_asset blocked: ${input.noteId} is outside project scope (${project}). Project notes live under ${prefix}.`
                );
            }

            return this.assetStore.writeAsset({
                noteId: input.noteId,
                content: input.content,
                contentType: input.contentType
            });
        }

        // No anchor note — synthesise a virtual id inside the project folder
        // so assetsFolderForNote routes to Memory/<project>/_assets, then drop
        // relativePath from the result since there's no real note to be
        // relative to.
        const result = await this.assetStore.writeAsset({
            noteId: `${prefix}.virtual.md`,
            content: input.content,
            contentType: input.contentType
        });

        return {assetId: result.assetId, written: result.written, deduped: result.deduped};
    }

    // --- canvas ------------------------------------------------------------

    public async listCanvases(): Promise<CanvasSummary[]> {
        return listCanvasesInVault(this.vault.root);
    }

    public async readCanvas(id: string): Promise<CanvasDocument> {
        return readCanvasFromVault(this.vault.root, id);
    }

    public async writeCanvas(id: string, doc: CanvasDocument): Promise<void> {
        await writeCanvasToVault(this.vault.root, id, doc);
    }

    public async deleteCanvas(id: string): Promise<void> {
        await deleteCanvasFromVault(this.vault.root, id);
    }

    // --- Roadmap (per-project, vault-native markdown) -----------------------

    /** Summaries of every project's roadmap in the vault (for the list view). */
    public listRoadmaps(): RoadmapSummary[] {
        return listRoadmapSummaries(this.notes.list());
    }

    /**
     * Read a project's roadmap. Returns an empty roadmap (no steps) when the
     * `Memory/<project>/_roadmap.md` note does not exist yet.
     */
    public readRoadmap(project: string): Roadmap {
        const note = this.notes.tryGet(roadmapPathFor(project));
        return roadmapFromNote(project, note, new Date().toISOString());
    }

    /**
     * Persist a roadmap: normalize it (dependency gating + hour/progress
     * roll-up + timestamp), then write `Memory/<project>/_roadmap.md` through
     * the unscoped note path so it is indexed, versioned and searchable. The
     * frontmatter carries the step tree; the body is auto-rendered. Returns the
     * normalized roadmap so callers reflect roll-up values back to the client.
     */
    public async writeRoadmap(roadmap: Roadmap): Promise<Roadmap> {
        const normalized = normalizeRoadmap(roadmap, new Date().toISOString());
        const input = roadmapWriteInput(normalized);
        await this.writer.writeNoteUnscoped(input as NoteWriteInput, 'roadmap');
        return normalized;
    }

    /** Commit history of a project's roadmap note (newest first); empty without history. */
    public async roadmapHistory(project: string, limit = 30): Promise<NoteHistoryEntry[]> {
        return this.historyService.noteHistory(roadmapPathFor(project), limit);
    }

    /**
     * Roll a project's roadmap back to a past commit. Reads the roadmap note as
     * it stood at `commitSha`, parses its step tree, and writes it forward as a
     * NEW commit. History is append-only, so the rollback is itself reversible —
     * roll forward again to any later sha. Throws when history is disabled, the
     * commit predates the note, or that version has no valid roadmap frontmatter.
     */
    public async rollbackRoadmap(project: string, commitSha: string): Promise<Roadmap> {
        const id = roadmapPathFor(project);
        const raw = await this.historyService.noteVersion(id, commitSha);
        const parsed = matter(raw, MATTER_NO_CACHE);
        const roadmap = parseRoadmap(project, parsed.data as Record<string, unknown>);
        if (roadmap === null) {
            throw new Error(`commit ${commitSha.slice(0, 8)} has no valid roadmap for project "${project}"`);
        }
        return this.writeRoadmap({...roadmap, project});
    }

    // --- Benchmarks (per-project, vault-native markdown) ---------------------

    /** Summaries of every project's benchmark set in the vault (for the list view). */
    public listBenchmarks(): BenchmarkSummary[] {
        return listBenchmarkSummaries(this.notes.list());
    }

    /**
     * Read a project's benchmark set. Returns an empty set (no entries) when
     * the `Memory/<project>/_benchmarks.md` note does not exist yet.
     */
    public readBenchmarks(project: string): BenchmarkSet {
        const note = this.notes.tryGet(benchmarkPathFor(project));
        return benchmarkSetFromNote(project, note, new Date().toISOString());
    }

    /**
     * Persist a benchmark set: normalize it (timestamp only — no roll-up/
     * gating like roadmap), then write `Memory/<project>/_benchmarks.md`
     * through the unscoped note path so it is indexed, versioned and
     * searchable.
     */
    public async writeBenchmarks(set: BenchmarkSet): Promise<BenchmarkSet> {
        const normalized = normalizeBenchmarks(set, new Date().toISOString());
        const input = benchmarkWriteInput(normalized);
        await this.writer.writeNoteUnscoped(input as NoteWriteInput, 'benchmark');
        return normalized;
    }

    // --- consent -----------------------------------------------------------

    /**
     * The just-in-time consent broker. MCP tool handlers use this to
     * long-poll the UI when a note carries `frontmatter.mcp_consent === "pending"`.
     * Web routes use it to list pending requests and forward approve/deny.
     */
    public getConsentStore(): ConsentStore {
        return this.consentStore;
    }

    /**
     * Approve or deny a pending consent request. Resolves the store
     * side (releases the long-poll on the MCP tool handler) and
     * persists the decision into the note's frontmatter so subsequent
     * MCP reads skip the prompt.
     *
     * Returns null when the request id is unknown or already resolved
     * (idempotent double-click safety).
     */
    public async resolveConsent(id: string, decision: ConsentDecision): Promise<ConsentRequest | null> {
        const pending = this.consentStore.getById(id);
        if (pending === undefined || pending.decision !== undefined) return null;

        // Write the frontmatter FIRST so any long-polling MCP handler
        // that wakes up from the resolve-event and immediately re-reads
        // the note sees the new mcp_consent value. If we resolved the
        // store first, the emit would race the write.
        const note = this.notes.tryGet(pending.noteId);
        if (note !== undefined) {
            const updatedFrontmatter: Frontmatter = {
                ...note.frontmatter,
                mcp_consent: decision,
                mcp_consent_at: new Date().toISOString()
            };

            await this.notes.write({
                path: note.id,
                content: note.content,
                frontmatter: updatedFrontmatter
            }, {
                message: `mcp-consent: ${decision} ${pending.noteId}`
            });
        }

        return this.consentStore.resolve(id, decision);
    }

    // --- file watcher ------------------------------------------------------

    public onVaultChange(listener: VaultChangeListener): () => void {
        this.vaultChangeListeners.add(listener);
        return () => {
            this.vaultChangeListeners.delete(listener);
        };
    }

    private attachWatcher(): void {
        if (this.skipWatcher) {
            // Server-Mode: no filesystem vault to watch. Other processes
            // on the same database are followed through the adapter's
            // change log instead (plan A6).
            const subscribe = this.notes.onExternalChange?.bind(this.notes);
            if (subscribe !== undefined) {
                this.stopExternalChanges = subscribe((changes) => {
                    this.externalQueue = this.externalQueue
                        .then(() => this.applyExternalChanges(changes))
                        .catch((error: unknown) => {
                            log.error('applying changes from another process failed', {error});
                        });
                });
            }
            return;
        }

        this.watcher.on('event', (event) => {
            this.handleEvent(event.kind, event.path).catch((error: unknown) => {
                log.error('watcher event failed', {path: event.path, kind: event.kind, error});
            });
        });

        this.watcher.start();
    }

    private async handleEvent(kind: 'created' | 'updated' | 'deleted', path: string): Promise<void> {
        await this.vault.handleExternalChange(path, kind);
        const id = this.idFromPath(path);

        if (kind === 'deleted') {
            await this.core.forgetExternal(id);
            this.notifyVaultChange({kind, path, noteId: id});
            return;
        }

        const note = this.notes.tryGet(id);

        if (!note) {
            return;
        }

        if (await this.core.absorbExternal(note)) {
            this.notifyVaultChange({kind, path, noteId: id});
        }
    }

    private async applyExternalChanges(changes: readonly ExternalNoteChange[]): Promise<void> {
        if (changes.some((c) => c.kind === 'reset')) {
            // The adapter reloaded everything; rebuild the indexes from it.
            await this.core.indexAll();
            this.core.invalidateTopology();
            return;
        }

        const changed: Note[] = [];
        const removed: NoteId[] = [];
        for (const change of changes) {
            if (change.kind === 'changed') changed.push(change.note);
            else if (change.kind === 'removed') removed.push(change.id);
        }
        this.core.applyRemote(changed, removed);

        for (const note of changed) {
            this.notifyVaultChange({kind: 'updated', path: note.path, noteId: note.id});
        }
        for (const id of removed) {
            this.notifyVaultChange({kind: 'deleted', path: id, noteId: id});
        }
    }

    private notifyVaultChange(event: VaultEvent & {noteId: NoteId}): void {
        for (const listener of this.vaultChangeListeners) {
            try {
                listener(event);
            } catch (error) {
                log.error('vault-change listener failed', {error});
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
