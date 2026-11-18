import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import type {SynaipseService} from '@synaipse/service';
import {resolveAssetPath} from '../asset-route.js';
import {readRawBody} from '../body.js';
import {noteSummary} from '../note-summary.js';
import {versionHeader} from '../graph-deltas.js';
import {intParam, jsonGzip} from '../cached-json.js';
import {decodeCursor, encodeCursor, isRecord, keysetPage} from '../pagination.js';
import {HttpError, badRequest, json, notFoundError, type RouteContext, type Router} from '../router.js';
import {asFrontmatter, asString, errorMessage, readJson, streamEvents, type RouteDeps} from './shared.js';

const ASSET_UPLOAD_LIMIT = 25 * 1024 * 1024;

const isNotesCursor = (v: unknown): v is {id: string} => isRecord(v) && typeof v.id === 'string';

/**
 * `GET /api/notes`. Without `limit`/`cursor` the whole list as an array
 * (the note tree needs all of it). With them one keyset page by id:
 * `{notes, nextCursor, total}`, optionally narrowed by `prefix`.
 */
const listNotes = async (service: SynaipseService, {req, res, url}: RouteContext): Promise<void> => {
    const paged = url.searchParams.has('limit') || url.searchParams.has('cursor');

    const version = versionHeader(service);

    if (!paged) {
        await jsonGzip(req, res, 200, service.listNotes().map((n) => noteSummary(service, n)), version);
        return;
    }

    const prefix = url.searchParams.get('prefix') ?? '';
    const cursor = decodeCursor(url.searchParams.get('cursor'), isNotesCursor);
    const notes = service.listNotes()
        .filter((n) => n.id.startsWith(prefix))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const page = keysetPage(notes, (n) => n.id, cursor?.id ?? null, intParam(url, 'limit', 500, 1, 5000));

    await jsonGzip(req, res, 200, {
        notes: page.items.map((n) => noteSummary(service, n)),
        nextCursor: page.nextKey === null ? null : encodeCursor({id: page.nextKey}),
        total: notes.length
    }, version);
};

export const registerNotesRoutes = (router: Router, {service}: RouteDeps): void => {
    router.get('/api/notes', (ctx) => listNotes(service, ctx));

    router.get('/api/notes/:id+/history', async ({res, url, params}) => {
        const entries = await service.noteHistory(params.id as string, intParam(url, 'limit', 50, 1, 500));
        json(res, 200, {entries});
    });

    router.get('/api/notes/:id+/version/:sha', async ({res, params}) => {
        const sha = params.sha as string;
        if (!/^[0-9a-f]+$/.test(sha)) throw notFoundError();

        try {
            const content = await service.noteVersion(params.id as string, sha);
            json(res, 200, {content, sha});
        } catch (error) {
            throw new HttpError(404, String(error));
        }
    });

    router.post('/api/notes/:id+/summarize', async ({req, res, params}) => {
        const body = await readJson<{save?: unknown}>(req).catch(() => ({save: false}));
        const save = body.save === true;

        await streamEvents(req, res, (abort) =>
            service.summarizeNote(params.id as string, {abort, saveToFrontmatter: save}));
    });

    router.get('/api/notes/:id+/diff', async ({res, url, params}) => {
        const from = url.searchParams.get('from');
        if (from === null) throw badRequest('missing ?from=');

        const to = url.searchParams.get('to');
        try {
            const unified = await service.noteDiff(params.id as string, from, to ?? undefined);
            json(res, 200, {unified});
        } catch (error) {
            throw new HttpError(500, String(error));
        }
    });

    router.get('/api/notes/:id+', ({res, params}) => {
        const note = service.getVault().tryGet(params.id as string);
        if (!note) throw notFoundError();
        json(res, 200, note);
    });

    router.put('/api/notes/:id+', async ({req, res, params}) => {
        const body = await readJson<{content?: unknown; frontmatter?: unknown}>(req);
        const content = asString(body.content, 'content');
        const frontmatter = asFrontmatter(body.frontmatter);

        const note = await service.writeNoteUnscoped({
            path: params.id as string,
            content,
            ...(frontmatter ? {frontmatter} : {})
        });

        json(res, 200, note);
    });

    router.delete('/api/notes/:id+', async ({res, params}) => {
        await service.deleteNoteUnscoped(params.id as string);
        json(res, 200, {deleted: true});
    });

    router.on(['GET', 'HEAD'], '/api/asset', async ({req, res, url}) => {
        const resolved = resolveAssetPath(service.getVault().root, url.searchParams.get('path'));

        if (!resolved.ok) {
            const err = resolved.error;
            if (err.kind === 'missing-path') throw badRequest('missing ?path=');
            if (err.kind === 'unsupported-extension') throw new HttpError(415, `unsupported extension: ${err.ext}`);
            throw new HttpError(403, `illegal path: ${err.reason}`);
        }

        let size: number;
        try {
            const st = await stat(resolved.value.absolutePath);
            if (!st.isFile()) throw notFoundError('not a file');
            size = st.size;
        } catch (error) {
            if (error instanceof HttpError) throw error;
            throw notFoundError('asset not found');
        }

        res.writeHead(200, {
            'Content-Type': resolved.value.contentType,
            'Content-Length': String(size),
            // Asset paths are content-hashed (img-<sha>.<ext>), so they
            // are immutable for as long as the bytes stay. Aggressive
            // caching is safe and helps notes with many embeds.
            'Cache-Control': 'public, max-age=31536000, immutable'
        });

        if (req.method === 'HEAD') {
            res.end();
            return;
        }

        createReadStream(resolved.value.absolutePath).pipe(res);
    });

    router.post('/api/assets/upload', async ({req, res}) => {
        const header = req.headers['x-synaipse-note-id'];
        const noteId = typeof header === 'string' ? decodeURIComponent(header) : '';
        if (noteId === '') throw badRequest('missing X-Synaipse-Note-Id header');

        const body = await readRawBody(req, ASSET_UPLOAD_LIMIT);
        if (body.length === 0) throw badRequest('empty body');

        const contentType = (req.headers['content-type'] as string | undefined) ?? null;
        try {
            json(res, 200, await service.writeNoteAsset(noteId, body, contentType));
        } catch (error) {
            throw new HttpError(500, errorMessage(error));
        }
    });

    router.get('/api/tags', ({res}) => {
        const tags = [...service.tags().entries()].map(([tag, ids]) => ({tag, count: ids.length}));
        json(res, 200, tags);
    });
};
