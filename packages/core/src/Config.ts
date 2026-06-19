import path from 'node:path';
import {SchemaErrors} from 'vts';
import {ConfigSchema, ConfigSchemaT} from './Schemas.js';
import {ConfigError} from './Errors.js';

export type Config = ConfigSchemaT;

const required = (name: string, value: string | undefined): string => {
    if (!value || value.trim() === '') {
        throw new ConfigError(`Missing required env var: ${name}`);
    }

    return value;
};

const int = (name: string, value: string | undefined, fallback: number): number => {
    if (value === undefined || value === '') {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);

    if (Number.isNaN(parsed)) {
        throw new ConfigError(`Env var ${name} must be an integer, got: ${value}`);
    }

    return parsed;
};

const resolveProvider = (env: NodeJS.ProcessEnv): 'voyage' | 'ollama' | 'huggingface' | 'none' => {
    const raw = (env.EMBEDDINGS_PROVIDER ?? 'none').toLowerCase();

    if (raw === 'voyage' || raw === 'ollama' || raw === 'huggingface' || raw === 'none') {
        return raw;
    }

    throw new ConfigError(`EMBEDDINGS_PROVIDER must be one of voyage|ollama|huggingface|none, got: ${raw}`);
};

const buildResearchConfig = (env: NodeJS.ProcessEnv): {
    provider: 'tavily' | 'searxng';
    apiKey?: string;
    url?: string;
} | null => {
    const raw = env.SYNAIPSE_RESEARCH_PROVIDER?.trim().toLowerCase();
    if (raw === undefined || raw === '' || raw === 'none') return null;

    if (raw === 'tavily') {
        const apiKey = env.SYNAIPSE_TAVILY_API_KEY?.trim();
        if (apiKey === undefined || apiKey.length === 0) {
            throw new ConfigError('SYNAIPSE_TAVILY_API_KEY is required for SYNAIPSE_RESEARCH_PROVIDER=tavily');
        }
        return {provider: 'tavily', apiKey};
    }

    if (raw === 'searxng') {
        const url = env.SYNAIPSE_SEARXNG_URL?.trim();
        if (url === undefined || url.length === 0) {
            throw new ConfigError('SYNAIPSE_SEARXNG_URL is required for SYNAIPSE_RESEARCH_PROVIDER=searxng');
        }
        return {provider: 'searxng', url};
    }

    throw new ConfigError(`SYNAIPSE_RESEARCH_PROVIDER must be one of tavily|searxng|none, got: ${raw}`);
};

const parseExcludePrefixes = (raw: string | undefined): string[] => {
    if (raw === undefined) return [];
    return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
};

type ChatProviderKind = 'ollama' | 'openai' | 'anthropic' | 'claude-shell';

const resolveChatProvider = (env: NodeJS.ProcessEnv): ChatProviderKind => {
    const raw = (env.SYNAIPSE_CHAT_PROVIDER ?? 'ollama').toLowerCase();

    if (raw === 'ollama' || raw === 'openai' || raw === 'anthropic' || raw === 'claude-shell') {
        return raw;
    }

    throw new ConfigError(
        `SYNAIPSE_CHAT_PROVIDER must be one of ollama|openai|anthropic|claude-shell, got: ${raw}`
    );
};

const buildChatConfig = (env: NodeJS.ProcessEnv): {
    provider: ChatProviderKind;
    model: string;
    url?: string;
    apiKey?: string;
    command?: string;
} => {
    const provider = resolveChatProvider(env);
    const explicit = env.SYNAIPSE_CHAT_MODEL?.trim();
    const apiKey = env.SYNAIPSE_CHAT_API_KEY?.trim();
    const url = env.SYNAIPSE_CHAT_URL?.trim();
    const command = env.SYNAIPSE_CHAT_COMMAND?.trim();

    if (provider === 'ollama') {
        return {
            provider,
            model: explicit !== undefined && explicit.length > 0 ? explicit : 'gemma3:4b',
            url: url ?? env.OLLAMA_URL ?? 'http://localhost:11434'
        };
    }

    if (provider === 'openai') {
        return {
            provider,
            model: explicit !== undefined && explicit.length > 0 ? explicit : 'gpt-4o-mini',
            url: url ?? 'https://api.openai.com',
            ...(apiKey !== undefined && apiKey.length > 0 ? {apiKey} : {})
        };
    }

    if (provider === 'anthropic') {
        if (apiKey === undefined || apiKey.length === 0) {
            throw new ConfigError('SYNAIPSE_CHAT_API_KEY is required for provider=anthropic');
        }

        return {
            provider,
            model: explicit !== undefined && explicit.length > 0 ? explicit : 'claude-sonnet-4-6',
            apiKey,
            ...(url !== undefined ? {url} : {})
        };
    }

    // claude-shell: model is optional (CLI alias like 'sonnet' or 'opus').
    // If unset, we leave it empty so the CLI picks its own default — passing
    // a fake alias here would error out at the Claude CLI ("model X does not
    // exist"). The chat layer falls back to provider.kind for the display
    // label when this is empty, so the badge still shows something useful.
    return {
        provider,
        model: explicit ?? '',
        command: command !== undefined && command.length > 0 ? command : 'claude'
    };
};

export const parseGitAuthor = (raw: string): {name: string; email: string} => {
    const match = raw.match(/^\s*(.+?)\s*<\s*(\S+@\S+)\s*>\s*$/);

    if (match === null) {
        throw new ConfigError(`Author must be 'Name <email>', got: ${raw}`);
    }

    return {name: match[1]!, email: match[2]!};
};

const PROJECT_TAG_RE = /^[A-Za-z0-9_./:-]+$/;

export const parseProjectTags = (raw: string | undefined): string[] => {
    if (raw === undefined || raw.trim().length === 0) {
        return [];
    }

    return raw.split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && PROJECT_TAG_RE.test(t));
};

export const loadConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): Config => {
    const provider = resolveProvider(env);

    const vaultPath = path.resolve(env.SYNAIPSE_VAULT_PATH ?? './vault');

    // App-state defaults (index cache, chat store) sit as hidden sidecars
    // inside the vault. The walker skips dot-prefixed dirs and only picks
    // up `.md`, so they stay out of the notes list / graph / search index,
    // and the user always has write permission since they own the vault.
    // `./data/` would be a bad default — it's typically root-owned because
    // docker-compose creates it for the Qdrant / Ollama volumes.
    const base = {
        vaultPath,
        indexCachePath: path.resolve(env.SYNAIPSE_INDEX_CACHE ?? path.join(vaultPath, '.synaipse-index.json')),
        chatStoreDir: path.resolve(env.SYNAIPSE_CHAT_STORE_DIR ?? path.join(vaultPath, '.synaipse-chats')),
        embeddings: {provider},
        qdrant: {
            url: env.QDRANT_URL ?? 'http://localhost:6333',
            ...(env.QDRANT_API_KEY !== undefined && env.QDRANT_API_KEY !== ''
                ? {apiKey: env.QDRANT_API_KEY}
                : {}),
            collection: env.QDRANT_COLLECTION ?? 'synaipse'
        },
        server: {
            name: env.MCP_SERVER_NAME ?? 'synaipse',
            version: env.MCP_SERVER_VERSION ?? '0.1.0'
        },
        web: {
            port: int('WEB_PORT', env.WEB_PORT, 5757)
        }
    };

    const projectName = env.SYNAIPSE_PROJECT?.trim();
    const gitAutoCommit = (env.SYNAIPSE_GIT_AUTOCOMMIT ?? 'true').toLowerCase();
    const gitEnabled = gitAutoCommit !== 'false' && gitAutoCommit !== '0' && gitAutoCommit !== 'no';
    const gitAuthorRaw = env.SYNAIPSE_GIT_AUTHOR ?? 'Synaipse <synaipse@local>';
    const gitAuthor = parseGitAuthor(gitAuthorRaw);

    const raw: unknown = {
        ...base,
        ...(provider === 'voyage'
            ? {
                voyage: {
                    apiKey: required('VOYAGE_API_KEY', env.VOYAGE_API_KEY),
                    model: env.VOYAGE_MODEL ?? 'voyage-3-large'
                }
            }
            : {}),
        ...(provider === 'ollama'
            ? {
                ollama: {
                    url: env.OLLAMA_URL ?? 'http://localhost:11434',
                    model: env.OLLAMA_MODEL ?? 'nomic-embed-text'
                }
            }
            : {}),
        ...(provider === 'huggingface'
            ? {
                huggingface: {
                    model: env.HUGGINGFACE_MODEL ?? 'Xenova/all-MiniLM-L6-v2'
                }
            }
            : {}),
        ...(projectName !== undefined && projectName.length > 0
            ? {
                project: {
                    name: projectName,
                    ...(parseProjectTags(env.SYNAIPSE_PROJECT_TAGS).length > 0
                        ? {extraTags: parseProjectTags(env.SYNAIPSE_PROJECT_TAGS)}
                        : {})
                }
            }
            : {}),
        git: {autoCommit: gitEnabled, author: gitAuthor},
        chat: buildChatConfig(env),
        ...(buildResearchConfig(env) !== null ? {research: buildResearchConfig(env)!} : {}),
        ...(parseExcludePrefixes(env.SYNAIPSE_EMBED_EXCLUDE_PREFIXES).length > 0
            ? {embedExcludePrefixes: parseExcludePrefixes(env.SYNAIPSE_EMBED_EXCLUDE_PREFIXES)}
            : {})
    };

    const errors: SchemaErrors = [];

    if (!ConfigSchema.validate(raw, errors)) {
        throw new ConfigError(`Invalid config: ${JSON.stringify(errors)}`);
    }

    return raw;
};