import {spawn} from 'node:child_process';

/**
 * Streaming LLM provider abstraction. All implementations yield incremental
 * tokens; the final yield carries `done: true` and an optional totalTokens
 * count when the backend reports usage.
 */

export interface LlmStreamEvent {
    token?: string;
    totalTokens?: number;
    done?: boolean;
}

export interface LlmMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface LlmStreamOptions {
    system: string;
    user: string;
    history?: readonly {role: 'user' | 'assistant'; content: string}[];
    abort?: AbortSignal;
}

export interface LlmProvider {
    /** Human-readable provider name shown in the UI ('ollama', 'openai', ...). */
    readonly kind: LlmProviderKind;
    /** Model identifier shown in the UI. */
    readonly model: string;
    stream(options: LlmStreamOptions): AsyncGenerator<LlmStreamEvent, void, void>;
}

export type LlmProviderKind = 'ollama' | 'openai' | 'anthropic' | 'claude-shell';

export interface OllamaConfig {
    kind: 'ollama';
    url: string;
    model: string;
    fetch?: typeof fetch;
}

export interface OpenAiConfig {
    kind: 'openai';
    url: string;
    model: string;
    apiKey?: string;
    fetch?: typeof fetch;
}

export interface AnthropicConfig {
    kind: 'anthropic';
    model: string;
    apiKey: string;
    url?: string;
    fetch?: typeof fetch;
}

export interface ClaudeShellConfig {
    kind: 'claude-shell';
    /** Path/name of the Claude Code CLI binary (default: 'claude'). */
    command: string;
    /** Model alias accepted by `claude --model` (e.g. 'sonnet', 'opus'). Optional. */
    model: string;
    /** Extra args passed verbatim after `--print`. */
    extraArgs?: readonly string[];
}

export type LlmConfig = OllamaConfig | OpenAiConfig | AnthropicConfig | ClaudeShellConfig;

const buildMessages = (opts: LlmStreamOptions): LlmMessage[] => {
    const messages: LlmMessage[] = [{role: 'system', content: opts.system}];

    for (const m of opts.history ?? []) {
        messages.push({role: m.role, content: m.content});
    }

    messages.push({role: 'user', content: opts.user});
    return messages;
};

async function* readSseLines(
    response: Response
): AsyncGenerator<string, void, void> {
    if (response.body === null) {
        throw new Error('LLM returned no body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const {value, done} = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, {stream: true});
        let nl = buffer.indexOf('\n');

        while (nl !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line.length > 0) yield line;
            nl = buffer.indexOf('\n');
        }
    }

    const tail = buffer.trim();
    if (tail.length > 0) yield tail;
}

/** Ollama uses newline-delimited JSON (not SSE). */
class OllamaProvider implements LlmProvider {
    public readonly kind = 'ollama' as const;
    public readonly model: string;
    private readonly url: string;
    private readonly fetchImpl: typeof fetch;

    public constructor(config: OllamaConfig) {
        this.model = config.model;
        this.url = config.url.replace(/\/$/, '');
        this.fetchImpl = config.fetch ?? fetch;
    }

    public async *stream(opts: LlmStreamOptions): AsyncGenerator<LlmStreamEvent, void, void> {
        const messages = buildMessages(opts);
        const body = {model: this.model, messages, stream: true};

        const init: RequestInit = {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        };

        if (opts.abort !== undefined) init.signal = opts.abort;

        const response = await this.fetchImpl(`${this.url}/api/chat`, init);

        if (!response.ok) {
            throw new Error(`Ollama ${response.status}: ${await response.text()}`);
        }

        for await (const line of readSseLines(response)) {
            let parsed: {message?: {content?: string}; done?: boolean; eval_count?: number};

            try {
                parsed = JSON.parse(line) as typeof parsed;
            } catch {
                continue;
            }

            const tokenText = parsed.message?.content;

            if (typeof tokenText === 'string' && tokenText.length > 0) {
                yield {token: tokenText};
            }

            if (parsed.done === true) {
                yield {
                    done: true,
                    ...(typeof parsed.eval_count === 'number' ? {totalTokens: parsed.eval_count} : {})
                };
            }
        }
    }
}

/** OpenAI-compatible Chat Completions streaming (works with OpenAI, llama.cpp, vLLM, LM Studio, ...). */
class OpenAiProvider implements LlmProvider {
    public readonly kind = 'openai' as const;
    public readonly model: string;
    private readonly url: string;
    private readonly apiKey: string | undefined;
    private readonly fetchImpl: typeof fetch;

    public constructor(config: OpenAiConfig) {
        this.model = config.model;
        this.url = config.url.replace(/\/$/, '');
        this.apiKey = config.apiKey;
        this.fetchImpl = config.fetch ?? fetch;
    }

    public async *stream(opts: LlmStreamOptions): AsyncGenerator<LlmStreamEvent, void, void> {
        const messages = buildMessages(opts);
        const body = {model: this.model, messages, stream: true};
        const headers: Record<string, string> = {'Content-Type': 'application/json'};

        if (this.apiKey !== undefined) headers.Authorization = `Bearer ${this.apiKey}`;

        const init: RequestInit = {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        };

        if (opts.abort !== undefined) init.signal = opts.abort;

        const response = await this.fetchImpl(`${this.url}/v1/chat/completions`, init);

        if (!response.ok) {
            throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
        }

        let totalTokens = 0;

        for await (const line of readSseLines(response)) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
                yield {done: true, ...(totalTokens > 0 ? {totalTokens} : {})};
                return;
            }

            let parsed: {choices?: Array<{delta?: {content?: string}}>; usage?: {total_tokens?: number}};
            try {
                parsed = JSON.parse(payload);
            } catch {
                continue;
            }

            const text = parsed.choices?.[0]?.delta?.content;
            if (typeof text === 'string' && text.length > 0) {
                yield {token: text};
            }

            if (typeof parsed.usage?.total_tokens === 'number') {
                totalTokens = parsed.usage.total_tokens;
            }
        }

        yield {done: true, ...(totalTokens > 0 ? {totalTokens} : {})};
    }
}

/** Anthropic Messages API streaming. */
class AnthropicProvider implements LlmProvider {
    public readonly kind = 'anthropic' as const;
    public readonly model: string;
    private readonly url: string;
    private readonly apiKey: string;
    private readonly fetchImpl: typeof fetch;

    public constructor(config: AnthropicConfig) {
        this.model = config.model;
        this.url = (config.url ?? 'https://api.anthropic.com').replace(/\/$/, '');
        this.apiKey = config.apiKey;
        this.fetchImpl = config.fetch ?? fetch;
    }

    public async *stream(opts: LlmStreamOptions): AsyncGenerator<LlmStreamEvent, void, void> {
        const history = opts.history ?? [];
        const messages = [
            ...history.map((m) => ({role: m.role, content: m.content})),
            {role: 'user' as const, content: opts.user}
        ];

        const body = {
            model: this.model,
            system: opts.system,
            messages,
            max_tokens: 4096,
            stream: true
        };

        const init: RequestInit = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(body)
        };

        if (opts.abort !== undefined) init.signal = opts.abort;

        const response = await this.fetchImpl(`${this.url}/v1/messages`, init);

        if (!response.ok) {
            throw new Error(`Anthropic ${response.status}: ${await response.text()}`);
        }

        let totalTokens = 0;
        let eventType = '';

        for await (const line of readSseLines(response)) {
            if (line.startsWith('event:')) {
                eventType = line.slice(6).trim();
                continue;
            }

            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') break;

            let parsed: {
                type?: string;
                delta?: {type?: string; text?: string};
                usage?: {output_tokens?: number; input_tokens?: number};
                message?: {usage?: {output_tokens?: number}};
            };
            try {
                parsed = JSON.parse(payload);
            } catch {
                continue;
            }

            if (eventType === 'content_block_delta' || parsed.type === 'content_block_delta') {
                const text = parsed.delta?.text;
                if (typeof text === 'string' && text.length > 0) yield {token: text};
            }

            const out = parsed.usage?.output_tokens ?? parsed.message?.usage?.output_tokens;
            if (typeof out === 'number') totalTokens = out;
        }

        yield {done: true, ...(totalTokens > 0 ? {totalTokens} : {})};
    }
}

/**
 * Shells out to the Claude Code CLI (`claude --print`). The CLI reads the
 * prompt from stdin and writes the answer to stdout. Streaming is line-based
 * (no token granularity), which means the UI sees the response in larger
 * chunks but still incrementally.
 */
class ClaudeShellProvider implements LlmProvider {
    public readonly kind = 'claude-shell' as const;
    public readonly model: string;
    private readonly command: string;
    private readonly extraArgs: readonly string[];

    public constructor(config: ClaudeShellConfig) {
        this.model = config.model;
        this.command = config.command;
        this.extraArgs = config.extraArgs ?? [];
    }

    public async *stream(opts: LlmStreamOptions): AsyncGenerator<LlmStreamEvent, void, void> {
        const historyText = (opts.history ?? [])
            .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n\n');

        const prompt = historyText.length === 0
            ? `${opts.system}\n\n${opts.user}`
            : `${opts.system}\n\n${historyText}\n\nUser: ${opts.user}`;

        const args = ['--print'];
        if (this.model.length > 0) args.push('--model', this.model);
        args.push(...this.extraArgs);

        const child = spawn(this.command, args, {stdio: ['pipe', 'pipe', 'pipe']});

        if (opts.abort !== undefined) {
            const onAbort = (): void => {
                if (!child.killed) child.kill('SIGTERM');
            };
            opts.abort.addEventListener('abort', onAbort, {once: true});
        }

        child.stdin.write(prompt);
        child.stdin.end();

        const decoder = new TextDecoder();
        let stderr = '';

        child.stderr.on('data', (chunk: Buffer) => {
            stderr += decoder.decode(chunk);
        });

        const stdoutQueue: string[] = [];
        let stdoutDone = false;
        let resolveWaiter: (() => void) | null = null;

        child.stdout.on('data', (chunk: Buffer) => {
            stdoutQueue.push(decoder.decode(chunk));
            if (resolveWaiter !== null) {
                resolveWaiter();
                resolveWaiter = null;
            }
        });

        const exitPromise = new Promise<number>((resolve, reject) => {
            child.on('exit', (code) => {
                stdoutDone = true;
                if (resolveWaiter !== null) {
                    resolveWaiter();
                    resolveWaiter = null;
                }
                resolve(code ?? 0);
            });
            child.on('error', reject);
        });

        while (!stdoutDone || stdoutQueue.length > 0) {
            if (stdoutQueue.length === 0) {
                await new Promise<void>((resolve) => {
                    resolveWaiter = resolve;
                });
                continue;
            }

            const chunk = stdoutQueue.shift() as string;
            if (chunk.length > 0) yield {token: chunk};
        }

        const code = await exitPromise;
        if (code !== 0) {
            throw new Error(`claude-shell exited ${code}: ${stderr.trim()}`);
        }

        yield {done: true};
    }
}

export const createLlmProvider = (config: LlmConfig): LlmProvider => {
    switch (config.kind) {
        case 'ollama': return new OllamaProvider(config);
        case 'openai': return new OpenAiProvider(config);
        case 'anthropic': return new AnthropicProvider(config);
        case 'claude-shell': return new ClaudeShellProvider(config);
    }
};
