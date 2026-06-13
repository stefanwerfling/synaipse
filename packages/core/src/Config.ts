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

const resolveProvider = (env: NodeJS.ProcessEnv): 'voyage' | 'ollama' | 'none' => {
    const raw = (env.EMBEDDINGS_PROVIDER ?? 'none').toLowerCase();

    if (raw === 'voyage' || raw === 'ollama' || raw === 'none') {
        return raw;
    }

    throw new ConfigError(`EMBEDDINGS_PROVIDER must be one of voyage|ollama|none, got: ${raw}`);
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

    const base = {
        vaultPath: path.resolve(env.SYNAIPSE_VAULT_PATH ?? './vault'),
        indexCachePath: path.resolve(env.SYNAIPSE_INDEX_CACHE ?? './data/synaipse-index.json'),
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
        git: {autoCommit: gitEnabled, author: gitAuthor}
    };

    const errors: SchemaErrors = [];

    if (!ConfigSchema.validate(raw, errors)) {
        throw new ConfigError(`Invalid config: ${JSON.stringify(errors)}`);
    }

    return raw;
};