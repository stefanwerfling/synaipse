import type {ServerResponse} from 'node:http';
import type {AuditEntry, PrimerEntry, PrimerReason, PrimeResult} from '@synaipse/service';
import {intParam} from '../cached-json.js';
import {decodeCursor, encodeCursor, isRecord} from '../pagination.js';
import {HttpError, badRequest, json, type Router} from '../router.js';
import type {RouteDeps} from './shared.js';

const REASON_HEADINGS: Record<PrimerReason, string> = {
    pinned: 'Pinned',
    recent_session: 'Recent sessions',
    project_decision: 'Project decisions',
    topic: 'Topic-relevant',
    referenced: 'Referenced (cited in past sessions)',
    hot: 'Hot (by backlink count)',
    recent: 'Recently edited'
};

const REASON_ORDER: readonly PrimerReason[] = [
    'pinned',
    'recent_session',
    'project_decision',
    'topic',
    'referenced',
    'hot',
    'recent'
];

export const renderPrimerMarkdown = (result: PrimeResult): string => {
    const lines: string[] = [];
    const project = result.project ?? '(unscoped)';
    const generatedAt = new Date().toISOString();

    lines.push(`# Synaipse Primer — ${project}`);
    lines.push('');
    lines.push(
        `*Generated ${generatedAt}. ${result.context.length} context entries, ` +
        `${result.todoCount} open TODOs, ~${result.tokenEstimate} tokens.*`
    );
    lines.push('');
    lines.push('This file is regenerated on every Claude Code session start by the');
    lines.push('`synaipse-memory` plugin. Read the listed notes via `synaipse_read_note`');
    lines.push('when their topic comes up in this session.');
    lines.push('');

    const grouped = new Map<PrimerReason, PrimerEntry[]>();

    for (const entry of result.context) {
        const existing = grouped.get(entry.reason);

        if (existing) {
            existing.push(entry);
        } else {
            grouped.set(entry.reason, [entry]);
        }
    }

    for (const reason of REASON_ORDER) {
        const entries = grouped.get(reason);

        if (entries === undefined || entries.length === 0) {
            continue;
        }

        lines.push(`## ${REASON_HEADINGS[reason]}`);
        lines.push('');

        for (const entry of entries) {
            const excerpt = entry.excerpt.replace(/\s+/g, ' ').trim().slice(0, 200);
            lines.push(`- **${entry.title}** (\`${entry.id}\`) — ${excerpt}`);
        }

        lines.push('');
    }

    if (result.todoSample.length > 0) {
        lines.push('## TODOs (sample)');
        lines.push('');

        for (const todo of result.todoSample) {
            lines.push(`- [ ] from \`${todo.noteId}\`: ${todo.text}`);
        }

        lines.push('');
    }

    return lines.join('\n');
};

const writeTextPlain = (res: ServerResponse, status: number, body: string): void => {
    res.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8'});
    res.end(body);
};

type AuditKind = AuditEntry['kind'];

const AUDIT_KINDS: ReadonlySet<string> = new Set<AuditKind>(['chat', 'summarize', 'compile', 'relink', 'research', 'embed']);

const isAuditKind = (v: string | null): v is AuditKind => v !== null && AUDIT_KINDS.has(v);

const isAuditCursor = (v: unknown): v is {line: number} =>
    isRecord(v) && typeof v.line === 'number' && Number.isInteger(v.line) && v.line >= 0;

const isCommitCursor = (v: unknown): v is {sha: string} =>
    isRecord(v) && typeof v.sha === 'string' && /^[0-9a-f]{40}$/.test(v.sha);

/** Primer, session context, activity, audit trail and history snapshots. */
export const registerMemoryRoutes = (router: Router, {service}: RouteDeps): void => {
    router.get('/api/prime', async ({res, url}) => {
        const topic = url.searchParams.get('topic') ?? '';
        const projectParam = url.searchParams.get('project');
        const project = projectParam !== null && projectParam.length > 0 ? projectParam : service.getProject();

        const result = await service.prime({
            project,
            limit: intParam(url, 'limit', 15, 1, 100),
            ...(topic.length > 0 ? {topic} : {}),
            includeCrawler: url.searchParams.get('includeCrawler') === 'true'
        });

        if (url.searchParams.get('format') === 'markdown') {
            writeTextPlain(res, 200, renderPrimerMarkdown(result));
            return;
        }

        json(res, 200, result);
    });

    router.get('/api/activity', async ({res, url}) => {
        json(res, 200, await service.getActivity({
            sinceDays: intParam(url, 'days', 7, 1, 365),
            limit: intParam(url, 'limit', 1000, 1, 5000)
        }));
    });

    // Commit list beyond the report's top 100, newest-first, keyset by sha.
    router.get('/api/activity/commits', async ({res, url}) => {
        const cursor = decodeCursor(url.searchParams.get('cursor'), isCommitCursor);
        let page;
        try {
            page = await service.activityCommits({
                limit: intParam(url, 'limit', 50, 1, 500),
                ...(cursor !== null ? {before: cursor.sha} : {})
            });
        } catch {
            throw badRequest('cursor points to an unknown commit');
        }

        json(res, 200, {commits: page.commits, nextCursor: page.next === null ? null : encodeCursor({sha: page.next})});
    });

    router.get('/api/audit', async ({res, url}) => {
        // DSGVO Layer 4: read the persistent log of external LLM calls.
        // Query params (all optional): ?limit=N, ?cursor=<nextCursor>,
        // ?afterTs=<ms-epoch>, ?provider=<id>, ?kind=chat|summarize|…,
        // ?includeEmbed=1. Newest entries come first.
        const params = url.searchParams;
        const kindRaw = params.get('kind');
        const kind = isAuditKind(kindRaw) ? kindRaw : undefined;
        const afterTs = Number(params.get('afterTs') ?? Number.NaN);
        const provider = params.get('provider');
        const cursor = decodeCursor(params.get('cursor'), isAuditCursor);

        // Embed entries default off — they're high-frequency and a different
        // privacy class than chat completions (no note bodies, just queries).
        // An explicit kind=embed filter is honoured regardless.
        const excludeKinds: readonly AuditKind[] | undefined =
            params.get('includeEmbed') !== '1' && kind !== 'embed' ? ['embed'] : undefined;

        const [page, total] = await Promise.all([
            service.getAuditPage({
                limit: intParam(url, 'limit', 200, 1, 1000),
                ...(cursor !== null ? {beforeLine: cursor.line} : {}),
                ...(Number.isFinite(afterTs) ? {afterTs} : {}),
                ...(provider !== null ? {provider} : {}),
                ...(kind !== undefined ? {kind} : {}),
                ...(excludeKinds !== undefined ? {excludeKinds} : {})
            }),
            service.getAuditCount(excludeKinds !== undefined ? {excludeKinds} : {})
        ]);

        json(res, 200, {
            entries: page.entries,
            total,
            nextCursor: page.nextBeforeLine === null ? null : encodeCursor({line: page.nextBeforeLine})
        });
    });

    router.get('/api/health/verify', async ({res}) => {
        const report = await service.verifyHistory();
        json(res, 200, report === null ? {enabled: false} : {enabled: true, ...report});
    });

    const snapshot = async (res: ServerResponse, url: URL, sha: string, op: string): Promise<void> => {
        if (!/^[0-9a-f]{40}$/.test(sha)) {
            throw badRequest('expected /api/snapshot/<40-char-sha>[/<sub>]');
        }

        try {
            if (op === '' || op === 'list') {
                const treePath = url.searchParams.get('path') ?? undefined;
                const entries = await service.snapshotList(sha, treePath);
                json(res, 200, {sha, path: treePath ?? '', entries});
                return;
            }

            if (op === 'walk') {
                const prefix = url.searchParams.get('prefix') ?? '';
                const files = await service.snapshotWalk(sha, prefix);
                json(res, 200, {sha, prefix, count: files.length, files});
                return;
            }
        } catch (error) {
            throw new HttpError(404, String(error));
        }

        throw new HttpError(404, `unknown snapshot op: ${op}`);
    };

    router.get('/api/snapshot/:sha', ({res, url, params}) => snapshot(res, url, params.sha as string, ''));
    router.get('/api/snapshot/:sha/:op+', ({res, url, params}) => snapshot(res, url, params.sha as string, params.op as string));
};
