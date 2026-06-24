import {api, type ChatSession, type ChatTurnDto, type ChatSourceRef} from './Api.js';
import {ChatSidebar} from './ChatSidebar.js';
import {clear, el} from './Dom.js';
import {renderMarkdownInto} from './MarkdownPreview.js';
import {PreviewDialog, previewSkipFlag} from './PreviewDialog.js';

export type ChatSource = ChatSourceRef;

interface PrivacyStats {
    filteredPrivate?: number;
    redactions?: ReadonlyArray<{kind: string; count: number}>;
}

interface Message {
    role: 'user' | 'assistant';
    text: string;
    sources?: ChatSource[];
    model?: string;
    streaming?: boolean;
    privacy?: PrivacyStats;
}

const HISTORY_MAX_TURNS = 12;          // 6 user + 6 assistant
const HISTORY_MAX_CHARS_PER_MSG = 4000;

/** Strip per-turn machine markers and the trailing wikilink-citation
 * line from a message body before rendering. Same shape as the
 * server-side parser uses; kept in the client too as a safety net. */
const stripChatMarkers = (text: string): string => {
    return text
        .replace(/<!--chat:(?:user|assistant)(?:\s+[\s\S]*?)?-->/g, '')
        .replace(/\n+(?:\[\[[^\]]+\]\](?:\s*·\s*\[\[[^\]]+\]\])*)\s*$/, '')
        .trim();
};

export interface ChatPanelCallbacks {
    onOpenNote: (noteId: string) => void;
}

/**
 * Two-pane chat panel: left sidebar with saved sessions, right pane with
 * the active conversation rendered as alternating user / assistant cards.
 * Each assistant card carries a model badge and a Sources pill that
 * expands to a list of [[note]] links — the same links also live in the
 * saved chat note's body so the vault graph picks up backlinks.
 *
 * Sessions are auto-saved to vault/Chats/&lt;id&gt;.md after each completed
 * assistant response. Hard-refresh / reopen the tab and the sidebar
 * shows your history.
 */
export class ChatPanel {
    public readonly element: HTMLElement;
    private readonly sidebar: ChatSidebar;
    private readonly mainPane: HTMLElement;
    private readonly thread: HTMLElement;
    private readonly input: HTMLTextAreaElement;
    private readonly sendBtn: HTMLButtonElement;
    private readonly stopBtn: HTMLButtonElement;
    private readonly researchBtn: HTMLButtonElement;
    private readonly saveAsNoteBtn: HTMLButtonElement;
    private readonly stickyHost: HTMLElement;
    private readonly threadTitle: HTMLElement;
    private readonly providerBadge: HTMLElement;

    private messages: Message[] = [];
    private streaming = false;
    private currentAbort: AbortController | null = null;
    private model = '—';
    private enabled = false;
    private researchEnabled = false;
    private chatProvider: string | null = null;
    private chatProviderIsLocal: boolean | null = null;
    private stickyContext: {label: string; text: string} | null = null;

    /** Server-side chat note id, or null if this session hasn't been saved yet. */
    private sessionId: string | null = null;
    private sessionTitle: string | null = null;
    private autoSaveInFlight: Promise<void> | null = null;

    /**
     * Last seen scrollTop of the thread. We snapshot on tab-leave and
     * restore on tab-enter because clear(body) detaches the panel and
     * browsers reset scrollTop to 0 on re-attach.
     */
    private lastScrollTop = 0;

    public constructor(private readonly cb: ChatPanelCallbacks) {
        this.element = el('div', {class: 'chat-panel'});

        this.sidebar = new ChatSidebar({
            onSelect: (id) => void this.loadChat(id),
            onNew: () => this.startNewChat()
        });

        this.threadTitle = el('h2', {class: 'chat-title', text: 'Neues Gespräch'});

        this.saveAsNoteBtn = el('button', {
            class: 'chat-save-as-note',
            attrs: {type: 'button', title: 'Gespräch als Notiz in den Vault übernehmen'},
            text: '📥 Als Notiz speichern',
            on: {click: () => void this.handleSaveAsNote()}
        }) as HTMLButtonElement;
        this.saveAsNoteBtn.hidden = true;

        this.providerBadge = el('span', {class: 'chat-provider-badge'});
        this.providerBadge.hidden = true;

        const head = el('div', {class: 'chat-head'},
            this.threadTitle,
            el('div', {class: 'chat-head-right'}, this.providerBadge, this.saveAsNoteBtn)
        );

        this.stickyHost = el('div', {class: 'chat-sticky', attrs: {hidden: 'true'}});
        this.thread = el('div', {class: 'chat-thread'});

        this.input = el('textarea', {
            class: 'chat-input',
            attrs: {
                placeholder: 'Frag etwas zu deinen Notizen…  (Enter zum Senden, Shift+Enter für Zeilenumbruch)',
                rows: 3
            },
            on: {
                keydown: (event) => {
                    const ev = event as KeyboardEvent;
                    if (ev.key === 'Enter' && !ev.shiftKey) {
                        ev.preventDefault();
                        void this.send();
                    }
                }
            }
        }) as HTMLTextAreaElement;

        this.sendBtn = el('button', {
            class: 'chat-send',
            attrs: {type: 'button'},
            text: 'Senden',
            on: {click: () => void this.send()}
        }) as HTMLButtonElement;

        this.researchBtn = el('button', {
            class: 'chat-research',
            attrs: {type: 'button', title: 'Web durchsuchen statt Vault'},
            text: '🔎 Web',
            on: {click: () => void this.send({research: true})}
        }) as HTMLButtonElement;
        this.researchBtn.hidden = true;

        this.stopBtn = el('button', {
            class: 'chat-stop',
            attrs: {type: 'button', title: 'Antwort stoppen'},
            text: 'Stop',
            on: {click: () => this.stop()}
        }) as HTMLButtonElement;
        this.stopBtn.hidden = true;

        const inputRow = el('div', {class: 'chat-input-row'},
            this.input, this.stopBtn, this.researchBtn, this.sendBtn
        );

        this.mainPane = el('div', {class: 'chat-main'},
            head,
            this.thread,
            this.stickyHost,
            inputRow
        );

        this.element.appendChild(this.sidebar.element);
        this.element.appendChild(this.mainPane);

        void this.sidebar.refresh();
    }

    public setInfo(
        enabled: boolean,
        model: string | null,
        provider?: string | null,
        research?: boolean,
        providerIsLocal?: boolean | null
    ): void {
        this.enabled = enabled;
        this.researchEnabled = research === true;
        this.model = model ?? '—';
        this.chatProvider = provider ?? null;
        this.chatProviderIsLocal = providerIsLocal ?? null;

        this.renderProviderBadge(provider ?? null, providerIsLocal ?? null);

        this.researchBtn.hidden = !this.researchEnabled;

        if (!enabled) {
            clear(this.thread);
            this.thread.appendChild(
                el('div', {class: 'chat-empty', text: 'Chat nicht konfiguriert. Setze SYNAIPSE_CHAT_PROVIDER + Modell in deiner .env.'})
            );
            this.input.disabled = true;
            return;
        }

        this.input.disabled = false;
        if (this.messages.length === 0) this.renderEmpty();
    }

    private renderProviderBadge(provider: string | null, isLocal: boolean | null): void {
        clear(this.providerBadge);

        if (provider === null || isLocal === null) {
            this.providerBadge.hidden = true;
            this.providerBadge.className = 'chat-provider-badge';
            return;
        }

        this.providerBadge.hidden = false;
        this.providerBadge.className = `chat-provider-badge ${isLocal ? 'local' : 'external'}`;

        const icon = isLocal ? '🔒' : '🌐';
        const label = isLocal ? 'local' : 'external';
        const title = isLocal
            ? `Vault-Inhalte verlassen den Host nicht (${provider})`
            : `Vault-Inhalte werden an einen externen LLM-Provider übertragen (${provider})`;

        this.providerBadge.setAttribute('title', title);
        this.providerBadge.appendChild(el('span', {class: 'chat-provider-icon', text: icon}));
        this.providerBadge.appendChild(el('span', {class: 'chat-provider-label', text: label}));
        this.providerBadge.appendChild(el('span', {class: 'chat-provider-sep', text: '·'}));
        this.providerBadge.appendChild(el('span', {class: 'chat-provider-name', text: provider}));
    }

    public focusInput(): void {
        this.input.focus();
    }

    /** Capture scroll position before the panel gets unmounted on tab switch. */
    public onHide(): void {
        this.lastScrollTop = this.thread.scrollTop;
    }

    /** Restore scroll position after the panel is re-mounted. Re-attach
     * happens synchronously so we can read scrollHeight straight away. */
    public onShow(): void {
        // requestAnimationFrame so the browser has finished layout — without
        // it, scrollTop assignment can be clamped to 0 because clientHeight
        // is still 0 on the freshly-attached element.
        requestAnimationFrame(() => {
            this.thread.scrollTop = this.lastScrollTop;
        });
    }

    public setStickyContext(label: string, text: string): void {
        this.stickyContext = {label, text};
        this.renderSticky();
    }

    /**
     * Entry point for "Ask about this" from the note viewer. If there's
     * already a conversation going, ask the user whether to continue it
     * or start fresh — otherwise just attach the sticky and let them
     * type. Either way, the sticky context lands on the next send.
     */
    public attachContextForQuestion(label: string, text: string): void {
        if (this.messages.length === 0) {
            this.setStickyContext(label, text);
            this.focusInput();
            return;
        }

        // Pending sticky lives in this.stickyContext during the prompt
        // so it survives a "Neuer Chat" reset (which clears messages
        // but we re-apply it just below).
        this.stickyContext = {label, text};
        this.renderContextChoice();
    }

    public clearStickyContext(): void {
        this.stickyContext = null;
        this.renderSticky();
    }

    /**
     * Inline prompt above the sticky-context bar: "continue this chat"
     * vs "start a new chat". Lives in the same host as the sticky so it
     * disappears once the user picks an option.
     */
    private renderContextChoice(): void {
        clear(this.stickyHost);
        this.stickyHost.removeAttribute('hidden');

        const label = this.stickyContext?.label ?? '';

        const continueBtn = el('button', {
            class: 'chat-context-choice-btn primary',
            attrs: {type: 'button'},
            text: 'Aktuellen Chat fortführen',
            on: {click: () => {
                this.renderSticky();
                this.focusInput();
            }}
        });

        const newBtn = el('button', {
            class: 'chat-context-choice-btn',
            attrs: {type: 'button'},
            text: 'Neues Gespräch starten',
            on: {click: () => {
                const pending = this.stickyContext;
                this.startNewChat();
                if (pending !== null) {
                    this.setStickyContext(pending.label, pending.text);
                }
                this.focusInput();
            }}
        });

        this.stickyHost.appendChild(
            el('div', {class: 'chat-context-choice'},
                el('div', {class: 'chat-context-choice-text'},
                    el('strong', {text: 'Frage zu '}),
                    el('span', {class: 'chat-context-choice-label', text: label}),
                    el('span', {text: ' — wo soll sie hin?'})
                ),
                el('div', {class: 'chat-context-choice-actions'}, continueBtn, newBtn)
            )
        );
    }

    private renderSticky(): void {
        clear(this.stickyHost);

        if (this.stickyContext === null) {
            this.stickyHost.setAttribute('hidden', 'true');
            return;
        }

        this.stickyHost.removeAttribute('hidden');

        const preview = this.stickyContext.text.length > 200
            ? `${this.stickyContext.text.slice(0, 200)}…`
            : this.stickyContext.text;

        this.stickyHost.appendChild(
            el('div', {class: 'chat-sticky-row'},
                el('span', {class: 'chat-sticky-icon', text: '↳'}),
                el('div', {class: 'chat-sticky-main'},
                    el('div', {class: 'chat-sticky-label', text: this.stickyContext.label}),
                    el('div', {class: 'chat-sticky-text', text: preview})
                ),
                el('button', {
                    class: 'chat-sticky-clear',
                    attrs: {type: 'button', 'aria-label': 'context entfernen'},
                    text: '×',
                    on: {click: () => this.clearStickyContext()}
                })
            )
        );
    }

    // -- session lifecycle --------------------------------------------------

    private startNewChat(): void {
        if (this.streaming) this.stop();

        this.sessionId = null;
        this.sessionTitle = null;
        this.messages = [];
        this.threadTitle.textContent = 'Neues Gespräch';
        this.sidebar.setActive(null);
        this.updateSaveAsNoteVisibility();
        this.renderEmpty();
        this.focusInput();
    }

    private async loadChat(id: string): Promise<void> {
        if (this.streaming) this.stop();

        try {
            const session = await api.getChat(id);
            this.hydrateFromSession(session);
            this.sidebar.setActive(id);
        } catch (cause) {
            console.error('failed to load chat', cause);
        }
    }

    private hydrateFromSession(session: ChatSession): void {
        this.sessionId = session.id;
        this.sessionTitle = session.title;
        this.threadTitle.textContent = session.title;

        this.messages = session.turns.map((turn) => {
            const msg: Message = {role: turn.role, text: turn.content};
            if (turn.model !== undefined) msg.model = turn.model;
            if (turn.sources !== undefined) msg.sources = turn.sources;
            return msg;
        });

        this.updateSaveAsNoteVisibility();
        this.renderThread();
    }

    /** Show the "Save as Note" button only once the chat has been persisted. */
    private updateSaveAsNoteVisibility(): void {
        this.saveAsNoteBtn.hidden = this.sessionId === null || this.messages.length === 0;
    }

    private async handleSaveAsNote(): Promise<void> {
        if (this.sessionId === null) return;

        const originalText = this.saveAsNoteBtn.textContent;
        this.saveAsNoteBtn.disabled = true;
        this.saveAsNoteBtn.textContent = 'Speichere…';

        try {
            const {noteId} = await api.saveChatAsNote(this.sessionId);
            this.saveAsNoteBtn.textContent = '✓ Im Vault';
            window.setTimeout(() => {
                this.saveAsNoteBtn.textContent = originalText;
                this.saveAsNoteBtn.disabled = false;
            }, 1500);
            // Jump straight into the new vault note so the user sees it.
            window.setTimeout(() => this.cb.onOpenNote(noteId), 800);
        } catch (cause) {
            console.error('save chat as note failed', cause);
            this.saveAsNoteBtn.textContent = 'Fehler';
            window.setTimeout(() => {
                this.saveAsNoteBtn.textContent = originalText;
                this.saveAsNoteBtn.disabled = false;
            }, 1500);
        }
    }

    /** Derive a chat title from the first user turn — first ~70 chars on one line. */
    private deriveTitle(): string {
        const firstUser = this.messages.find((m) => m.role === 'user');
        if (firstUser === undefined) return 'Neues Gespräch';

        const trimmed = firstUser.text.trim().replace(/\s+/g, ' ');
        if (trimmed.length === 0) return 'Neues Gespräch';

        return trimmed.length > 70 ? `${trimmed.slice(0, 70)}…` : trimmed;
    }

    /** Auto-save after each completed assistant response. */
    private async autoSave(): Promise<void> {
        // Coalesce concurrent calls — if a save is already in flight, await it
        // and then start a fresh one with the latest state.
        if (this.autoSaveInFlight !== null) {
            try {
                await this.autoSaveInFlight;
            } catch {
                // previous save's error is logged separately; carry on
            }
        }

        const completed = this.messages.filter((m) => m.streaming !== true);
        if (completed.length === 0) return;

        const turns: ChatTurnDto[] = completed.map((m) => {
            const dto: ChatTurnDto = {role: m.role, content: m.text};
            if (m.model !== undefined) dto.model = m.model;
            if (m.sources !== undefined && m.sources.length > 0) dto.sources = m.sources;
            return dto;
        });

        const title = this.sessionTitle ?? this.deriveTitle();
        const lastAssistantModel = [...completed].reverse().find((m) => m.role === 'assistant' && m.model !== undefined)?.model;

        const input = lastAssistantModel !== undefined
            ? {title, turns, lastModel: lastAssistantModel}
            : {title, turns};

        const work = (async () => {
            try {
                if (this.sessionId === null) {
                    const session = await api.createChat(input);
                    this.sessionId = session.id;
                    this.sessionTitle = session.title;
                    this.threadTitle.textContent = session.title;
                    await this.sidebar.refresh();
                    this.sidebar.setActive(session.id);
                } else {
                    const session = await api.updateChat(this.sessionId, input);
                    this.sessionTitle = session.title;
                    await this.sidebar.refresh();
                    this.sidebar.setActive(session.id);
                }
                this.updateSaveAsNoteVisibility();
            } catch (cause) {
                console.error('auto-save chat failed', cause);
            }
        })();

        this.autoSaveInFlight = work;
        await work;
        this.autoSaveInFlight = null;
    }

    // -- rendering ----------------------------------------------------------

    private renderEmpty(): void {
        clear(this.thread);
        this.thread.appendChild(
            el('div', {class: 'chat-empty', text: 'Frag was zu deinen Notes — die Antwort basiert ausschließlich auf dem Vault. Gespräche werden automatisch im Vault unter Chats/ gespeichert.'})
        );
    }

    private renderThread(): void {
        clear(this.thread);

        if (this.messages.length === 0) {
            this.renderEmpty();
            return;
        }

        for (const msg of this.messages) {
            this.thread.appendChild(this.renderMessage(msg));
        }

        this.thread.scrollTop = this.thread.scrollHeight;
    }

    private renderMessage(msg: Message): HTMLElement {
        if (msg.role === 'user') {
            const userBody = el('div', {class: 'chat-bubble-body md-preview'});
            renderMarkdownInto(userBody, stripChatMarkers(msg.text));
            return el('div', {class: 'chat-msg user'},
                el('div', {class: 'chat-bubble user'}, userBody)
            );
        }

        // Assistant card. Layout:
        //
        //   ┌──────────────────────────────────────────────┐
        //   │ <answer text, rendered markdown>              │
        //   │                                               │
        //   │ [● claude-shell]   [📎 Quellen · 3]           │ ← footer row
        //   │                                               │
        //   │ <expandable sources list, when open>          │
        //   └──────────────────────────────────────────────┘
        //
        // Model pill sits next to the Sources pill so the user sees
        // *for this answer* which LLM produced it — independent of
        // whatever the global default is set to right now.
        const body = el('div', {class: 'chat-card-body md-preview'});
        // Defensive: strip any leaked structured-storage markers before
        // markdown render. They should never appear here (parser pulls
        // them out before the API returns turn content) but a stale browser
        // cache, a parser regression, or an LLM that mimics the pattern
        // would all leave visible noise otherwise.
        const cleanText = stripChatMarkers(msg.text);
        // Append the streaming cursor as a separate text node so we don't
        // pollute the markdown source with a literal '▍' that gets re-parsed
        // on every token.
        renderMarkdownInto(body, cleanText);
        if (msg.streaming === true) {
            body.appendChild(document.createTextNode('▍'));
        }

        const inner = el('div', {class: 'chat-card'}, body);

        // Per-answer model is authoritative — at the time of this answer it
        // might have been a different LLM than the current default. If the
        // saved turn has model="" or undefined (legacy files), we mark it
        // 'unbekannt' rather than guessing the current global.
        const modelText = msg.model !== undefined && msg.model.length > 0
            ? msg.model
            : 'unbekannt';
        const modelPill = el('span', {
            class: 'chat-card-model-pill',
            attrs: {title: `Diese Antwort wurde von ${modelText} erstellt`}
        },
            el('span', {class: 'chat-card-model-prefix', text: 'Antwort von'}),
            el('span', {class: 'chat-card-badge-dot'}),
            el('span', {class: 'chat-card-badge-label', text: modelText})
        );

        const footer = el('div', {class: 'chat-card-footer'}, modelPill);

        let sourcesList: HTMLElement | null = null;
        if (msg.sources !== undefined && msg.sources.length > 0) {
            const {pillBtn, list} = this.buildSourcesPill(msg.sources);
            footer.appendChild(pillBtn);
            sourcesList = list;
        }

        if (msg.privacy !== undefined) {
            const pill = this.buildPrivacyPill(msg.privacy);
            if (pill !== null) footer.appendChild(pill);
        }

        inner.appendChild(footer);
        if (sourcesList !== null) inner.appendChild(sourcesList);

        return el('div', {class: 'chat-msg assistant'}, inner);
    }

    private buildSourcesPill(sources: ChatSource[]): {pillBtn: HTMLButtonElement; list: HTMLElement} {
        const list = el('ul', {class: 'chat-card-sources-list'});
        list.hidden = true;

        for (const s of sources) {
            const isExternal = /^https?:\/\//.test(s.target);

            const item = el('li', {class: 'chat-card-source'},
                el('button', {
                    class: 'chat-card-source-link',
                    attrs: {type: 'button', title: s.target},
                    on: {
                        click: () => {
                            if (isExternal) {
                                window.open(s.target, '_blank', 'noopener,noreferrer');
                            } else {
                                this.cb.onOpenNote(s.target);
                            }
                        }
                    }
                },
                    el('span', {class: 'chat-card-source-index', text: `[^${s.index}]`}),
                    el('span', {class: 'chat-card-source-title', text: s.title})
                )
            );

            list.appendChild(item);
        }

        const pillBtn = el('button', {
            class: 'chat-card-sources-pill',
            attrs: {type: 'button', 'aria-expanded': 'false'},
            text: `📎 Quellen · ${sources.length}`
        }) as HTMLButtonElement;

        let expanded = false;
        pillBtn.addEventListener('click', () => {
            expanded = !expanded;
            list.hidden = !expanded;
            pillBtn.setAttribute('aria-expanded', String(expanded));
            pillBtn.classList.toggle('expanded', expanded);
        });

        return {pillBtn, list};
    }

    /**
     * Dry-run the chat against /api/chat/preview to count private filters
     * and redaction hits, then ask the user before the actual external
     * call. Returns true when the call may proceed (no privacy hits, or
     * user confirmed), false when the user cancelled. On API/network
     * failure we err on the side of *blocking* — silently letting the
     * call through would defeat the gate.
     */
    private async runPreviewGate(question: string): Promise<boolean> {
        let preview;
        try {
            preview = await api.chatPreview({question});
        } catch (cause) {
            console.error('DSGVO preview failed', cause);
            window.alert('DSGVO-Vorschau konnte nicht geladen werden — Senden wird abgebrochen. Siehe Browser-Konsole für Details.');
            return false;
        }

        const redactTotal = preview.redactions.reduce((sum, r) => sum + r.count, 0);

        // Nothing privacy-relevant to confirm — skip the modal, send straight through.
        if (preview.filteredPrivate === 0 && redactTotal === 0) {
            return true;
        }

        const dialog = new PreviewDialog();
        const result = await dialog.open({
            provider: this.chatProvider ?? 'external',
            filteredPrivate: preview.filteredPrivate,
            redactions: preview.redactions
        });

        if (result.confirmed && result.rememberSkip) {
            previewSkipFlag.set();
        }

        return result.confirmed;
    }

    /**
     * Small read-only pill summarizing what DSGVO Layer 2/3 did to this
     * answer's prompt: how many private notes were dropped, how many
     * PII/secret patterns were scrubbed. The tooltip lists the per-kind
     * breakdown so a user investigating "why didn't note X show up" has a
     * thread to pull. Returns null when there's nothing to report.
     */
    private buildPrivacyPill(stats: PrivacyStats): HTMLElement | null {
        const parts: string[] = [];
        const tooltipLines: string[] = [];

        if (stats.filteredPrivate !== undefined && stats.filteredPrivate > 0) {
            parts.push(`${stats.filteredPrivate} ausgeblendet`);
            tooltipLines.push(`${stats.filteredPrivate} Note(s) wurden ausgeblendet (Privat-Marker)`);
        }

        const redactions = stats.redactions ?? [];
        const redactTotal = redactions.reduce((sum, r) => sum + r.count, 0);

        if (redactTotal > 0) {
            parts.push(`${redactTotal} redacted`);
            const detail = redactions.map((r) => `${r.count} ${r.kind}`).join(', ');
            tooltipLines.push(`${redactTotal} PII/Secret-Treffer geschwärzt: ${detail}`);
        }

        if (parts.length === 0) return null;

        return el('span', {
            class: 'chat-card-privacy-pill',
            attrs: {title: tooltipLines.join('\n')}
        },
            el('span', {class: 'chat-card-privacy-icon', text: '🛡'}),
            el('span', {class: 'chat-card-privacy-label', text: parts.join(' · ')})
        );
    }

    // -- streaming + send ---------------------------------------------------

    private buildHistory(): {role: 'user' | 'assistant'; content: string}[] {
        const completed = this.messages.filter((m) => m.streaming !== true);
        const recent = completed.slice(-HISTORY_MAX_TURNS);

        return recent.map((m) => ({
            role: m.role,
            content: m.text.length > HISTORY_MAX_CHARS_PER_MSG
                ? `${m.text.slice(0, HISTORY_MAX_CHARS_PER_MSG)}\n\n…[truncated]`
                : m.text
        }));
    }

    private stop(): void {
        if (this.currentAbort !== null) {
            this.currentAbort.abort();
        }
    }

    private setStreaming(active: boolean): void {
        this.streaming = active;
        this.stopBtn.hidden = !active;
        this.sendBtn.hidden = active;
        this.input.disabled = active;
    }

    private async send(opts: {research?: boolean} = {}): Promise<void> {
        if (!this.enabled || this.streaming) return;

        const rawQuestion = this.input.value.trim();
        if (rawQuestion.length === 0) return;

        this.input.value = '';

        const sticky = this.stickyContext;
        const question = sticky === null
            ? rawQuestion
            : `Bezug auf folgenden Auszug aus **${sticky.label}**:\n\n> ${sticky.text.replace(/\n/g, '\n> ')}\n\n---\n\n${rawQuestion}`;

        // DSGVO preview gate (only for vault-grounded chat; research consumes
        // web results, not vault notes, so the privacy story is different).
        if (opts.research !== true
            && this.chatProviderIsLocal === false
            && !previewSkipFlag.isSet()
        ) {
            const allowed = await this.runPreviewGate(question);
            if (!allowed) {
                // User declined — restore the input so they can edit/retry.
                this.input.value = rawQuestion;
                return;
            }
        }

        if (sticky !== null) this.clearStickyContext();

        const history = this.buildHistory();

        const userMsg: Message = {role: 'user', text: question};
        const assistantMsg: Message = {role: 'assistant', text: '', streaming: true, sources: []};

        this.messages.push(userMsg);
        this.messages.push(assistantMsg);
        this.renderThread();

        this.setStreaming(true);
        this.currentAbort = new AbortController();

        try {
            const endpoint = opts.research === true ? '/api/research' : '/api/chat';
            const payload = opts.research === true
                ? {question}
                : {question, history};

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload),
                signal: this.currentAbort.signal
            });

            if (response.body === null) throw new Error('no response body');

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
                        const event = JSON.parse(line.slice(6));
                        this.handleEvent(assistantMsg, event);
                    } catch {
                        // ignore malformed
                    }
                }
            }
        } catch (cause) {
            if (cause instanceof DOMException && cause.name === 'AbortError') {
                assistantMsg.text += assistantMsg.text.length > 0 ? '\n\n[stopped]' : '[stopped]';
            } else {
                assistantMsg.text += `\n\n[error: ${String(cause)}]`;
            }
        } finally {
            assistantMsg.streaming = false;
            this.currentAbort = null;
            this.setStreaming(false);
            this.renderThread();
            void this.autoSave();
        }
    }

    private handleEvent(target: Message, event: {kind: string; [k: string]: unknown}): void {
        if (event.kind === 'start') {
            // Server emits sources with `noteId`, but the local ChatSource
            // shape uses `target` (so vault notes and external URLs share
            // one field). Map here so clicks resolve to a real note id.
            const raw = (event.sources as Array<{
                noteId: string;
                title: string;
                index: number;
                score?: number;
                snippet?: string;
            }> | undefined) ?? [];
            target.sources = raw.map((s) => {
                const ref: ChatSource = {target: s.noteId, title: s.title, index: s.index};
                if (s.score !== undefined) ref.score = s.score;
                if (s.snippet !== undefined) ref.snippet = s.snippet;
                return ref;
            });

            if (typeof event.model === 'string') {
                target.model = event.model;
            }

            const filteredPrivate = typeof event.filteredPrivate === 'number' ? event.filteredPrivate : undefined;
            const redactionsRaw = Array.isArray(event.redactions)
                ? (event.redactions as Array<{kind?: unknown; count?: unknown}>)
                    .filter((r) => typeof r.kind === 'string' && typeof r.count === 'number')
                    .map((r) => ({kind: r.kind as string, count: r.count as number}))
                : undefined;

            if (filteredPrivate !== undefined || (redactionsRaw !== undefined && redactionsRaw.length > 0)) {
                target.privacy = {
                    ...(filteredPrivate !== undefined ? {filteredPrivate} : {}),
                    ...(redactionsRaw !== undefined && redactionsRaw.length > 0 ? {redactions: redactionsRaw} : {})
                };
            }
        } else if (event.kind === 'sources') {
            const raw = (event.sources as Array<{index: number; url: string; title: string; snippet: string}> | undefined) ?? [];
            target.sources = raw.map((s) => ({
                index: s.index,
                target: s.url,
                title: s.title,
                score: 0,
                snippet: s.snippet
            }));
            target.model = `research · ${this.model}`;
        } else if (event.kind === 'status') {
            if (target.text.length === 0) {
                target.text = `_${String(event.message)}_`;
            }
        } else if (event.kind === 'token') {
            if (target.text.startsWith('_') && target.text.endsWith('_')) target.text = '';
            target.text += String(event.text ?? '');
        } else if (event.kind === 'error') {
            target.text += `\n\n[error: ${String(event.message)}]`;
        }

        this.renderThread();
    }
}