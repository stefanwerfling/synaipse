import {clear, el} from './Dom.js';
import {PersistentValue} from './Persistence.js';

export interface ChatSource {
    index: number;
    noteId: string;
    title: string;
    score: number;
    snippet?: string;
}

interface Message {
    role: 'user' | 'assistant';
    text: string;
    sources?: ChatSource[];
    model?: string;
    streaming?: boolean;
}

const STORAGE_HISTORY = 'synaipse.chat.history';
const HISTORY_MAX_TURNS = 12;          // 6 user + 6 assistant
const HISTORY_MAX_CHARS_PER_MSG = 4000;

export interface ChatPanelCallbacks {
    onOpenNote: (noteId: string) => void;
    onSaveAsNote?: (markdown: string) => Promise<{noteId: string} | null>;
}

const historyStore = new PersistentValue<Message[]>(STORAGE_HISTORY, []);

export class ChatPanel {
    public readonly element: HTMLElement;
    private readonly thread: HTMLElement;
    private readonly input: HTMLTextAreaElement;
    private readonly modelLabel: HTMLElement;
    private readonly sendBtn: HTMLButtonElement;
    private readonly stopBtn: HTMLButtonElement;
    private readonly clearBtn: HTMLButtonElement;
    private messages: Message[] = [];
    private streaming = false;
    private currentAbort: AbortController | null = null;
    private model = '—';
    private enabled = false;
    private stickyContext: {label: string; text: string} | null = null;
    private stickyHost!: HTMLElement;
    private readonly saveBtn: HTMLButtonElement;

    public constructor(private readonly cb: ChatPanelCallbacks) {
        this.element = el('div', {class: 'chat-panel'});

        this.modelLabel = el('span', {class: 'chat-model', text: '—'});

        this.clearBtn = el('button', {
            class: 'chat-clear',
            attrs: {type: 'button', title: 'Clear conversation'},
            text: 'Clear',
            on: {click: () => this.clearConversation()}
        }) as HTMLButtonElement;

        this.saveBtn = el('button', {
            class: 'chat-save',
            attrs: {type: 'button', title: 'Save this conversation as a note in your vault'},
            text: 'Save as note',
            on: {click: () => void this.saveAsNote()}
        }) as HTMLButtonElement;

        const head = el('div', {class: 'chat-head'},
            el('h2', {class: 'chat-title', text: 'Chat with your notes'}),
            el('div', {class: 'chat-head-right'}, this.modelLabel, this.saveBtn, this.clearBtn)
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
            text: 'Send',
            on: {click: () => void this.send()}
        }) as HTMLButtonElement;

        this.stopBtn = el('button', {
            class: 'chat-stop',
            attrs: {type: 'button', title: 'Stop streaming response'},
            text: 'Stop',
            on: {click: () => this.stop()}
        }) as HTMLButtonElement;

        this.stopBtn.hidden = true;

        const inputRow = el('div', {class: 'chat-input-row'}, this.input, this.stopBtn, this.sendBtn);

        this.element.appendChild(head);
        this.element.appendChild(this.thread);
        this.element.appendChild(this.stickyHost);
        this.element.appendChild(inputRow);

        this.restore();
    }

    public setInfo(enabled: boolean, model: string | null): void {
        this.enabled = enabled;
        this.model = model ?? '—';
        this.modelLabel.textContent = model ?? 'chat disabled';

        if (!enabled) {
            clear(this.thread);
            this.thread.appendChild(
                el('div', {class: 'chat-empty', text: 'Local chat is not configured. Set SYNAIPSE_CHAT_URL and SYNAIPSE_CHAT_MODEL, then start the ollama container.'})
            );
            this.input.disabled = true;
            return;
        }

        this.input.disabled = false;
        if (this.messages.length === 0) this.renderEmpty();
    }

    public focusInput(): void {
        this.input.focus();
    }

    public setStickyContext(label: string, text: string): void {
        this.stickyContext = {label, text};
        this.renderSticky();
    }

    public clearStickyContext(): void {
        this.stickyContext = null;
        this.renderSticky();
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
                    attrs: {type: 'button', 'aria-label': 'remove context'},
                    text: '×',
                    on: {click: () => this.clearStickyContext()}
                })
            )
        );
    }

    private async saveAsNote(): Promise<void> {
        if (this.cb.onSaveAsNote === undefined) return;
        if (this.messages.length === 0) return;
        if (this.streaming) return;

        const markdown = this.toMarkdown();

        try {
            const result = await this.cb.onSaveAsNote(markdown);

            if (result !== null) {
                this.saveBtn.textContent = '✓ Saved';
                window.setTimeout(() => {
                    this.saveBtn.textContent = 'Save as note';
                }, 1500);
            }
        } catch (cause) {
            this.saveBtn.textContent = 'Save failed';
            window.setTimeout(() => {
                this.saveBtn.textContent = 'Save as note';
            }, 2000);
            console.error('save chat failed', cause);
        }
    }

    private toMarkdown(): string {
        const now = new Date();
        const date = now.toISOString().slice(0, 10);
        const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        const lines: string[] = [];
        lines.push(`# Chat — ${date} ${time}`, '');

        for (const msg of this.messages) {
            if (msg.role === 'user') {
                lines.push(`## You`, '', msg.text.trim(), '');
            } else {
                lines.push(`## Synaipse (${msg.model ?? this.model})`, '', msg.text.trim(), '');

                if (msg.sources !== undefined && msg.sources.length > 0) {
                    lines.push(`**Sources:**`);
                    for (const s of msg.sources) {
                        lines.push(`- [^${s.index}] [[${s.title}]] · \`${s.noteId}\``);
                    }
                    lines.push('');
                }
            }
        }

        return lines.join('\n');
    }

    private restore(): void {
        const stored = historyStore.get();

        if (stored.length === 0) {
            this.renderEmpty();
            return;
        }

        // ignore any streaming flags on restore
        this.messages = stored.map((m) => ({...m, streaming: false}));
        this.renderThread();
    }

    private persist(): void {
        historyStore.set(this.messages);
    }

    private clearConversation(): void {
        if (this.streaming) {
            this.stop();
        }

        this.messages = [];
        this.persist();
        this.renderEmpty();
    }

    private renderEmpty(): void {
        clear(this.thread);
        this.thread.appendChild(
            el('div', {class: 'chat-empty', text: 'Frag was zu deinen Notes — die Antwort basiert ausschließlich auf dem Vault. Folgefragen funktionieren, Verlauf bleibt im Browser.'})
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
        const head = msg.role === 'user'
            ? el('div', {class: 'chat-msg-head user', text: 'You'})
            : el('div', {class: 'chat-msg-head assistant'},
                el('span', {text: 'Synaipse'}),
                el('span', {class: 'chat-msg-model', text: msg.model ?? this.model})
            );

        const body = el('div', {class: 'chat-msg-body'});
        body.textContent = msg.text + (msg.streaming === true ? '▍' : '');

        const wrap = el('div', {class: msg.role === 'user' ? 'chat-msg user' : 'chat-msg assistant'},
            head,
            body
        );

        if (msg.role === 'assistant' && msg.sources !== undefined && msg.sources.length > 0) {
            const sources = el('div', {class: 'chat-sources'},
                el('div', {class: 'chat-sources-head', text: 'Sources'})
            );

            for (const s of msg.sources) {
                sources.appendChild(this.renderSource(s));
            }

            wrap.appendChild(sources);
        }

        return wrap;
    }

    private renderSource(s: ChatSource): HTMLElement {
        return el('div', {class: 'chat-source'},
            el('button', {
                class: 'chat-source-link',
                attrs: {type: 'button', title: s.noteId},
                on: {click: () => this.cb.onOpenNote(s.noteId)}
            },
                el('span', {class: 'chat-source-index', text: `[^${s.index}]`}),
                el('span', {class: 'chat-source-title', text: s.title})
            )
        );
    }

    private buildHistory(): {role: 'user' | 'assistant'; content: string}[] {
        // last N completed turns (excludes the in-flight assistant placeholder)
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

    private async send(): Promise<void> {
        if (!this.enabled || this.streaming) return;

        const rawQuestion = this.input.value.trim();

        if (rawQuestion.length === 0) return;

        this.input.value = '';

        const sticky = this.stickyContext;
        const question = sticky === null
            ? rawQuestion
            : `Bezug auf folgenden Auszug aus **${sticky.label}**:\n\n> ${sticky.text.replace(/\n/g, '\n> ')}\n\n---\n\n${rawQuestion}`;

        if (sticky !== null) {
            this.clearStickyContext();
        }

        const history = this.buildHistory();

        const userMsg: Message = {role: 'user', text: question};
        const assistantMsg: Message = {role: 'assistant', text: '', streaming: true, sources: []};

        this.messages.push(userMsg);
        this.messages.push(assistantMsg);
        this.renderThread();
        this.persist();

        this.setStreaming(true);
        this.currentAbort = new AbortController();

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({question, history}),
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
            this.persist();
        }
    }

    private handleEvent(target: Message, event: {kind: string; [k: string]: unknown}): void {
        if (event.kind === 'start') {
            target.sources = (event.sources as ChatSource[] | undefined) ?? [];

            if (typeof event.model === 'string') {
                target.model = event.model;
            }
        } else if (event.kind === 'token') {
            target.text += String(event.text ?? '');
        } else if (event.kind === 'error') {
            target.text += `\n\n[error: ${String(event.message)}]`;
        }

        this.renderThread();
    }
}