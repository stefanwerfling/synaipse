import type {JobType} from './jobs.js';

/**
 * The single source of truth for which job types the HTTP surface accepts.
 * Shared by `POST /api/jobs` (one-shot runs) and `POST /api/schedules`
 * (persistent jobs) so the two validators never drift apart.
 */
export const ALLOWED_JOB_TYPES: readonly JobType[] = [
    'relink',
    'compile',
    'crawl-gitea',
    'crawl-devto',
    'crawl-github-stars',
    'crawl-code'
];

export const isJobType = (v: unknown): v is JobType =>
    typeof v === 'string' && ALLOWED_JOB_TYPES.includes(v as JobType);

/**
 * Validate a params object for a given job type. Returns an error message
 * string, or `null` when the params are acceptable. Provider secrets
 * (dev.to key, GitHub token) are intentionally optional here — the server
 * runner falls back to DEVTO_API_KEY / GITHUB_TOKEN from the environment.
 */
export const validateJobParams = (type: JobType, params: Record<string, unknown>): string | null => {
    switch (type) {
        case 'crawl-gitea':
            for (const key of ['baseUrl', 'owner', 'repo', 'project'] as const) {
                if (typeof params[key] !== 'string' || (params[key] as string).length === 0) {
                    return `params.${key} must be a non-empty string`;
                }
            }
            return null;

        case 'crawl-code':
            if (typeof params.repoPath !== 'string' || params.repoPath.trim().length === 0) {
                return 'params.repoPath must be a non-empty string (a repository path on the server host)';
            }
            return null;

        case 'crawl-devto':
        case 'crawl-github-stars':
            // Every field is optional; the token/apiKey defaults to server env.
            return null;

        case 'relink':
        case 'compile':
            if (typeof params.prefix !== 'string') {
                return 'params.prefix must be a string (empty = all notes)';
            }
            return null;

        default:
            return `unknown job type: ${String(type)}`;
    }
};
