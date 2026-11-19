import type {Note, NoteId} from '@synaipse/core';
import {runChat, runSummarize, type ChatEvent, type ChatOptions, type ChatSource, type SummarizeEvent} from '../Chat.js';
import {renderCompiledMarkdown, runCompile, type CompileEvent, type CompileResult} from '../Compile.js';
import {stripContainers} from '../Containers.js';
import type {LlmProvider, LlmProviderKind} from '../Llm.js';
import {isNotePrivate, redactSensitive, type RedactionHit} from '../Privacy.js';
import {renderRelatedSection, runRelink, stripRelatedSection, type AcceptedLink, type RelinkCandidate} from '../Relink.js';
import {runResearch, type ResearchEvent, type WebSearchProvider} from '../Research.js';
import type {AuditRecorder} from './AuditRecorder.js';
import type {NoteCore} from './NoteCore.js';
import type {NoteWriter} from './NoteWriter.js';
import type {SearchService} from './SearchService.js';

/**
 * Everything that sends vault content to the configured LLM: chat (with
 * its dry-run preview), summarize, compile, relink and web research.
 * Applies the DSGVO layers on the way out: private notes never reach an
 * external provider (Layer 2), PII is redacted (Layer 3), and each
 * external call is audited (Layer 4).
 */
export class LlmService {
    public constructor(
        private readonly core: NoteCore,
        private readonly searchService: SearchService,
        private readonly writer: NoteWriter,
        private readonly audit: AuditRecorder,
        private readonly chatProvider: LlmProvider | null,
        private readonly researchProvider: WebSearchProvider | null
    ) {}

    private get notes(): NoteCore['notes'] {
        return this.core.notes;
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

    public getChatProviderIsLocal(): boolean | null {
        return this.chatProvider?.isLocal() ?? null;
    }

    /**
     * Surface DSGVO note flags to UI / API consumers so the notes list can
     * render a lock icon next to private notes. Structure is an object (not
     * a bare boolean) so future flags can join without breaking the API.
     */
    public noteFlags(note: Note): {private: boolean} {
        return {private: isNotePrivate(note)};
    }

    /**
     * Dry-run of `chat()` that stops after source assembly — no LLM call,
     * no token cost. Returns the exact stats the UI's preview modal needs
     * to ask the user "send N notes with M redactions, OK?" before the
     * actual external call. Mirrors the search/filter/redact/snippet
     * hydration logic of chat() (see comment in chat() for the slice-
     * before-redact ordering and why it matters for honest counts).
     */
    public async chatPreview(options: ChatOptions): Promise<{
        providerIsLocal: boolean | null;
        filteredPrivate: number;
        redactions: RedactionHit[];
        sources: ChatSource[];
    }> {
        const provider = this.chatProvider;

        if (provider === null) {
            return {providerIsLocal: null, filteredPrivate: 0, redactions: [], sources: []};
        }

        const externalProvider = !provider.isLocal();
        const limit = options.limit ?? 12;
        const prefix = options.pathPrefix;
        const scope = prefix !== undefined && prefix.length > 0 ? {include: [prefix]} : undefined;
        // The prefix is applied inside the search; over-fetching is only
        // needed when the DSGVO filter may still drop private notes.
        const overFetch = externalProvider ? Math.max(limit * 6, 60) : limit;

        let filteredPrivate = 0;
        const redactCounts = new Map<string, number>();
        const tallyRedactions = (hits: readonly RedactionHit[]): void => {
            for (const h of hits) {
                redactCounts.set(h.kind, (redactCounts.get(h.kind) ?? 0) + h.count);
            }
        };

        const rawHits = await this.searchService.search(options.question, 'hybrid', overFetch, scope);

        const dsgvoFiltered = externalProvider
            ? rawHits.filter((h) => {
                const note = this.notes.tryGet(h.noteId);
                if (note !== undefined && isNotePrivate(note)) {
                    filteredPrivate++;
                    return false;
                }
                return true;
            })
            : rawHits;

        const sliced = dsgvoFiltered.slice(0, limit);

        const sources: ChatSource[] = sliced.map((hit, i) => {
            let snippet = hit.snippet;

            if (snippet === undefined) {
                const note = this.notes.tryGet(hit.noteId);
                if (note !== undefined && !(externalProvider && isNotePrivate(note))) {
                    snippet = note.content.replace(/^---[\s\S]*?---\n?/, '').slice(0, 500).trim();
                }
            }

            if (snippet !== undefined) {
                // Strip container fences always (LLM noise), redact only
                // when external (PII leaving the host).
                snippet = stripContainers(snippet);
                if (externalProvider) {
                    const r = redactSensitive(snippet);
                    tallyRedactions(r.hits);
                    snippet = r.redacted;
                }
            }

            return {
                index: i + 1,
                noteId: hit.noteId,
                title: hit.title,
                score: hit.score,
                ...(snippet !== undefined ? {snippet} : {})
            };
        });

        const redactions: RedactionHit[] = Array.from(redactCounts.entries())
            .map(([kind, count]) => ({kind, count}))
            .sort((a, b) => a.kind.localeCompare(b.kind));

        return {
            providerIsLocal: provider.isLocal(),
            filteredPrivate,
            redactions,
            sources
        };
    }

    /**
     * DSGVO Layer 2 guard. Returns true when the configured chat provider is
     * allowed to receive the given note's content. Local providers always
     * pass; external providers refuse private notes (frontmatter flags,
     * `#private` tag, `Private/`/`Personal/`/`secrets/` path prefix).
     * Returns true when no chat provider is configured at all — the caller
     * surfaces the missing-provider error separately.
     */
    private chatProviderMayReceive(note: Note): boolean {
        const provider = this.chatProvider;
        if (provider === null) return true;
        if (provider.isLocal()) return true;
        return !isNotePrivate(note);
    }

    /**
     * Two-stage LLM input preparation:
     *   1. `stripContainers` runs always — `:::infographic` & friends are
     *      visual sugar for the web UI, but for the LLM they're noise that
     *      bloats tokens and confuses structure.
     *   2. DSGVO Layer 3: when the chat provider is external, scrub PII /
     *      secrets (emails, IBANs, API tokens, …). Local providers skip
     *      step 2 because nothing leaves the host. See Privacy.ts for the
     *      detector catalogue + redaction marker shape.
     */
    private prepareForChat(content: string): string {
        const stripped = stripContainers(content);
        const provider = this.chatProvider;
        if (provider === null || provider.isLocal()) return stripped;
        return redactSensitive(stripped).redacted;
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

        const researchStart = Date.now();
        // Research uses web sources, not vault notes — no note-IDs to log,
        // and there's no Layer-3 redaction in this path (the LLM sees the
        // raw web content). The audit entry captures the question + duration
        // so the user can still review *what was asked* of an external LLM.
        yield* runResearch(
            {llm: this.chatProvider, search: this.researchProvider},
            {question, ...(opts.abort !== undefined ? {abort: opts.abort} : {})}
        );

        await this.audit.recordExternalCall({
            kind: 'research',
            noteIds: [],
            redactions: [],
            question: question.slice(0, 200),
            durationMs: Date.now() - researchStart
        });
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

        const note = this.notes.tryGet(id);

        if (note === undefined) {
            yield {kind: 'error', message: `note not found: ${id}`};
            return;
        }

        if (!this.chatProviderMayReceive(note)) {
            yield {kind: 'error', message: `note ${id} ist als privat markiert (frontmatter.private/dsgvo, #private-Tag oder Private/Personal/secrets/-Pfad) — bitte einen lokalen LLM-Provider konfigurieren, um sie zu verarbeiten.`};
            return;
        }

        let finalSummary = '';
        const summarizeStart = Date.now();
        // Compute Layer-3 redaction stats on the same content the LLM sees
        // so the audit log can report `N emails redacted`. Strip first
        // because the LLM sees stripped content (Layer 3 + container-strip).
        const preparedSummarize = stripContainers(note.content);
        const summarizeRedactions = provider.isLocal()
            ? []
            : redactSensitive(preparedSummarize).hits;

        for await (const event of runSummarize(provider, this.prepareForChat(note.content), opts.abort)) {
            yield event;

            if (event.kind === 'done') {
                finalSummary = event.summary;
            }
        }

        await this.audit.recordExternalCall({
            kind: 'summarize',
            noteIds: [id],
            redactions: summarizeRedactions,
            durationMs: Date.now() - summarizeStart
        });

        if (finalSummary.length > 0 && opts.saveToFrontmatter === true) {
            try {
                await this.writer.updateNote(id, {frontmatterPatch: {summary: finalSummary}}, {
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

        const externalProvider = !provider.isLocal();
        const chatStart = Date.now();
        let chatSourceIds: string[] = [];

        let filteredPrivate = 0;
        const redactCounts = new Map<string, number>();
        const tallyRedactions = (hits: readonly RedactionHit[]): void => {
            for (const h of hits) {
                redactCounts.set(h.kind, (redactCounts.get(h.kind) ?? 0) + h.count);
            }
        };

        const stream = runChat({
            search: async (q, prefix, limit) => {
                const scope = prefix !== undefined && prefix.length > 0 ? {include: [prefix]} : undefined;
                // The prefix is applied inside the search. Over-fetch only
                // when DSGVO filtering may drop hits, so `limit` stays
                // strong after the filter.
                const overFetch = externalProvider ? Math.max(limit * 6, 60) : limit;
                const hits = await this.searchService.search(q, 'hybrid', overFetch, scope);

                const dsgvoFiltered = externalProvider
                    ? hits.filter((h) => {
                        const note = this.notes.tryGet(h.noteId);
                        if (note !== undefined && isNotePrivate(note)) {
                            filteredPrivate++;
                            return false;
                        }
                        return true;
                    })
                    : hits;

                // Slice first, then redact — otherwise the over-fetch pool
                // would inflate redaction counts with snippets that never
                // reach the LLM.
                const sliced = dsgvoFiltered.slice(0, limit);

                // Strip container fences always (LLM noise reduction);
                // Layer 3 redaction only when external. readNote-derived
                // snippets get the same treatment below; both feed the same
                // buildContext() prompt assembly.
                return sliced.map((h) => {
                    if (h.snippet === undefined) return h;
                    const stripped = stripContainers(h.snippet);
                    if (!externalProvider) return {...h, snippet: stripped};
                    const r = redactSensitive(stripped);
                    tallyRedactions(r.hits);
                    return {...h, snippet: r.redacted};
                });
            },
            readNote: (id) => {
                const note = this.notes.tryGet(id);
                if (note === undefined) return undefined;
                const stripped = stripContainers(note.content);
                if (!externalProvider) return stripped;
                if (isNotePrivate(note)) {
                    // Defense-in-depth: search() should already have dropped
                    // private hits, so reaching here means a hit slipped past
                    // the filter. Count it anyway so the UI total is honest.
                    filteredPrivate++;
                    return undefined;
                }
                const r = redactSensitive(stripped);
                tallyRedactions(r.hits);
                return r.redacted;
            },
            provider
        }, options);

        // Amend the start event with the privacy stats accumulated during
        // the (synchronous) source assembly above. Counts are stable by the
        // time runChat yields 'start' — readNote/search have both finished.
        for await (const event of stream) {
            if (event.kind === 'start') {
                const redactions = Array.from(redactCounts.entries())
                    .map(([kind, count]) => ({kind, count}))
                    .sort((a, b) => a.kind.localeCompare(b.kind));

                chatSourceIds = event.sources.map((s) => s.noteId);

                yield {
                    ...event,
                    ...(filteredPrivate > 0 ? {filteredPrivate} : {}),
                    ...(redactions.length > 0 ? {redactions} : {})
                };
            } else {
                yield event;
            }
        }

        const finalRedactions = Array.from(redactCounts.entries())
            .map(([kind, count]) => ({kind, count}))
            .sort((a, b) => a.kind.localeCompare(b.kind));

        await this.audit.recordExternalCall({
            kind: 'chat',
            noteIds: chatSourceIds,
            redactions: finalRedactions,
            ...(filteredPrivate > 0 ? {filteredPrivate} : {}),
            question: options.question.slice(0, 200),
            durationMs: Date.now() - chatStart
        });
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

        const note = this.notes.tryGet(id);

        if (note === undefined) {
            yield {kind: 'error', message: `note not found: ${id}`};
            return;
        }

        if (!this.chatProviderMayReceive(note)) {
            yield {kind: 'error', message: `note ${id} ist als privat markiert — Compile gegen einen externen LLM-Provider ist gesperrt. Konfiguriere einen lokalen Provider (z. B. Ollama auf localhost).`};
            return;
        }

        // Sibling note path: drop the .md suffix, append .compiled.md
        const compiledPath = id.replace(/\.md$/i, '.compiled.md');
        const existing = this.notes.tryGet(compiledPath);

        if (existing !== undefined && opts.force !== true) {
            const sourceHash = existing.frontmatter.source_hash;
            if (sourceHash === note.hash) {
                yield {kind: 'done', result: null, compiledPath};
                return;
            }
        }

        let final: CompileResult | null = null;
        const compileStart = Date.now();
        const preparedCompile = stripContainers(note.content);
        const compileRedactions = provider.isLocal()
            ? []
            : redactSensitive(preparedCompile).hits;

        for await (const event of runCompile(provider, this.prepareForChat(note.content), opts.abort)) {
            yield event;
            if (event.kind === 'done') final = event.result;
        }

        await this.audit.recordExternalCall({
            kind: 'compile',
            noteIds: [id],
            redactions: compileRedactions,
            durationMs: Date.now() - compileStart
        });

        if (final === null) return;

        const markdown = renderCompiledMarkdown(note.id, note.title, final);

        const written = await this.writer.writeRaw({
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
        }, `synaipse: compile ${compiledPath}`);

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
        const note = this.notes.tryGet(id);
        if (note === undefined) throw new Error(`note not found: ${id}`);

        // Idempotency: if the note already has an explicit ## Related section
        // and the caller didn't force, treat as no-op.
        if (!opts.force && /\n## Related\n/.test(note.content)) {
            return {noteId: id, accepted: [], skipped: true};
        }

        const excludePrefixes = opts.excludePrefixes ?? ['chatgpt-import/', 'Clipped/'];
        // Excluded folders are filtered inside the search (plan P4 / A4);
        // the margin covers the note itself and duplicate titles.
        const fetchLimit = Math.max(opts.limit ?? 20, 40);
        const query = `${note.title}\n${note.content.replace(/^---[\s\S]*?---\n?/, '').slice(0, 400)}`;
        const hits = await this.searchService.search(query, 'hybrid', fetchLimit, {exclude: excludePrefixes});

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

        // DSGVO Layer 2: if the chat provider is external and the source
        // note (or its candidates) carry private markers, we must not send
        // their content to the LLM. Fall back to deterministic ranking
        // instead of failing — relink still produces useful links, just
        // without LLM-assisted reasoning.
        const useLlm = opts.useLlm === true
            && this.chatProvider !== null
            && this.chatProviderMayReceive(note);

        if (useLlm) {
            const external = this.chatProvider !== null && !this.chatProvider.isLocal();
            const relinkStart = Date.now();
            // Layer 2: drop private candidates from the LLM input pool.
            // Layer 3: redact snippets in the prompt; titles + scores stay
            // pristine so the LLM can echo titles back and we can match
            // candidates by title afterwards.
            const filtered = external
                ? candidates.filter((c) => {
                    const cand = this.notes.tryGet(c.noteId);
                    return cand === undefined || !isNotePrivate(cand);
                })
                : candidates;
            const filteredOut = candidates.length - filtered.length;
            const llmCandidates = filtered.map((c) => c.snippet === undefined
                ? c
                : {...c, snippet: this.prepareForChat(c.snippet)});
            const rawSnippet = note.content.replace(/^---[\s\S]*?---\n?/, '').slice(0, 1200);
            const noteSnippet = this.prepareForChat(rawSnippet);

            // Tally Layer-3 redactions on the actual prompt inputs so the
            // audit log can report how much PII was stripped pre-send.
            const relinkRedactionCounts = new Map<string, number>();
            if (external) {
                const tally = (text: string): void => {
                    for (const h of redactSensitive(stripContainers(text)).hits) {
                        relinkRedactionCounts.set(h.kind, (relinkRedactionCounts.get(h.kind) ?? 0) + h.count);
                    }
                };
                tally(rawSnippet);
                for (const c of filtered) if (c.snippet !== undefined) tally(c.snippet);
            }
            const relinkRedactions = Array.from(relinkRedactionCounts.entries())
                .map(([kind, count]) => ({kind, count}))
                .sort((a, b) => a.kind.localeCompare(b.kind));

            let finalAccepted: AcceptedLink[] | null = null;

            for await (const event of runRelink(
                this.chatProvider as LlmProvider,
                note.title,
                noteSnippet,
                llmCandidates.slice(0, 10),
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

            await this.audit.recordExternalCall({
                kind: 'relink',
                noteIds: [id, ...filtered.slice(0, 10).map((c) => c.noteId)],
                redactions: relinkRedactions,
                ...(filteredOut > 0 ? {filteredPrivate: filteredOut} : {}),
                durationMs: Date.now() - relinkStart
            });
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

        const written = await this.writer.writeRaw({
            path: id,
            content: next,
            frontmatter: note.frontmatter
        }, `synaipse: relink ${id}`);

        return {noteId: written.id, accepted, skipped: false};
    }
}
