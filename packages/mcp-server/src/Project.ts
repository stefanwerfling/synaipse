import type {IncomingHttpHeaders} from 'node:http';
import {parseGitAuthor, parseProjectTags} from '@synaipse/core';

const PROJECT_RE = /^[A-Za-z0-9_.-]+$/;

const sanitise = (value: string | undefined): string | undefined => {
    if (value === undefined) {
        return undefined;
    }

    const trimmed = value.trim();

    if (trimmed.length === 0) {
        return undefined;
    }

    return PROJECT_RE.test(trimmed) ? trimmed : undefined;
};

export const projectFromUrlPath = (rawUrl: string | undefined, basePath: string): string | undefined => {
    if (rawUrl === undefined) {
        return undefined;
    }

    const queryIdx = rawUrl.indexOf('?');
    const pathname = queryIdx === -1 ? rawUrl : rawUrl.slice(0, queryIdx);

    if (!pathname.startsWith(basePath)) {
        return undefined;
    }

    let rest = pathname.slice(basePath.length);

    if (rest.startsWith('/')) {
        rest = rest.slice(1);
    }

    if (rest.length === 0) {
        return undefined;
    }

    const slashIdx = rest.indexOf('/');
    const segment = slashIdx === -1 ? rest : rest.slice(0, slashIdx);

    return sanitise(decodeURIComponent(segment));
};

export const projectFromHeader = (headers: IncomingHttpHeaders): string | undefined => {
    const raw = headers['x-synaipse-project'];

    if (Array.isArray(raw)) {
        return sanitise(raw[0]);
    }

    return sanitise(raw);
};

export interface ResolveProjectInput {
    url?: string | undefined;
    headers?: IncomingHttpHeaders;
    basePath: string;
}

export const resolveProjectFromRequest = (input: ResolveProjectInput): string | undefined => {
    const fromPath = projectFromUrlPath(input.url, input.basePath);

    if (fromPath !== undefined) {
        return fromPath;
    }

    if (input.headers !== undefined) {
        return projectFromHeader(input.headers);
    }

    return undefined;
};

const headerString = (headers: IncomingHttpHeaders, key: string): string | undefined => {
    const raw = headers[key];

    if (Array.isArray(raw)) {
        return raw[0];
    }

    return raw;
};

export const authorFromHeader = (headers: IncomingHttpHeaders): {name: string; email: string} | undefined => {
    const raw = headerString(headers, 'x-synaipse-author');

    if (raw === undefined || raw.trim().length === 0) {
        return undefined;
    }

    try {
        return parseGitAuthor(raw);
    } catch {
        return undefined;
    }
};

export const extraTagsFromHeader = (headers: IncomingHttpHeaders): string[] | undefined => {
    const raw = headerString(headers, 'x-synaipse-project-tags');

    if (raw === undefined || raw.trim().length === 0) {
        return undefined;
    }

    const parsed = parseProjectTags(raw);
    return parsed.length === 0 ? undefined : parsed;
};

export interface RequestContext {
    project?: string;
    gitAuthor?: {name: string; email: string};
    extraTags?: string[];
}

export const resolveContextFromRequest = (input: ResolveProjectInput): RequestContext => {
    const ctx: RequestContext = {};
    const project = resolveProjectFromRequest(input);

    if (project !== undefined) {
        ctx.project = project;
    }

    if (input.headers !== undefined) {
        const author = authorFromHeader(input.headers);

        if (author !== undefined) {
            ctx.gitAuthor = author;
        }

        const tags = extraTagsFromHeader(input.headers);

        if (tags !== undefined) {
            ctx.extraTags = tags;
        }
    }

    return ctx;
};