import {PathNotFoundError} from 'ngit';

export const MS_PER_DAY = 86_400_000;

/** Notes per embedding group at start-up and at the end of a batch; progress is persisted after each group. */
export const EMBED_GROUP = 50;

/** Characters of a note embedded as its semantic fingerprint (related, suggestLinks). */
export const SEMANTIC_SAMPLE_CHARS = 1500;

export const isoDate = (timestamp: number): string => new Date(timestamp * 1000).toISOString();

export const buildCommitMessage = (tool: string, noteId: string, project: string | null): string => {
    const scope = project === null ? 'synaipse' : `synaipse(${project})`;
    return `${scope}: ${tool} ${noteId}`;
};

export const isPathNotFound = (err: unknown): boolean => {
    if (err instanceof PathNotFoundError) {
        return true;
    }

    return err instanceof Error && err.name === 'PathNotFoundError';
};

export const slugifyForPath = (input: string): string => {
    const out = input
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);

    return out.length === 0 ? 'chat' : out;
};

export const extractExcerpt = (content: string, max: number): string => {
    const body = content.replace(/^---[\s\S]*?---\s*/, '').trim();
    const flat = body.replace(/[#*_`>[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
    return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
};
