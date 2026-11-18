import type {InboxEntryRef, InboxTarget} from '@synaipse/service';
import {HttpError, json, requiredParam, type Router} from '../router.js';
import {errorMessage, readJson, type RouteDeps} from './shared.js';

/**
 * The `remember` inbox (plan P8 / C5): entries with merge candidates,
 * "In Note übernehmen" and "Verwerfen". Writes go through the service
 * (versioned, hash-guarded); a stale entry answers 409.
 */

const refOf = (body: Record<string, unknown>): InboxEntryRef => {
    const {inbox, time, text} = body;
    if (typeof inbox !== 'string' || typeof time !== 'string' || typeof text !== 'string') {
        throw new HttpError(400, 'inbox, time and text are required');
    }
    return {inbox, time, text};
};

const targetOf = (value: unknown): InboxTarget => {
    if (typeof value === 'object' && value !== null) {
        const t = value as Record<string, unknown>;
        if (typeof t.id === 'string' && t.id.length > 0) return {id: t.id};
        if (typeof t.newTitle === 'string') {
            return {newTitle: t.newTitle, ...(typeof t.newPath === 'string' && t.newPath.length > 0 ? {newPath: t.newPath} : {})};
        }
    }
    throw new HttpError(400, 'target must be {id} or {newTitle, newPath?}');
};

/** Stale entry → 409, a target that already exists → 409, other caller errors → 400. */
const mapError = (error: unknown): HttpError => {
    if (error instanceof HttpError) return error;
    const message = errorMessage(error);
    if (/not found|changed meanwhile|already exists|hash/i.test(message)) return new HttpError(409, message);
    return new HttpError(400, message);
};

export const registerInboxRoutes = (router: Router, {service}: RouteDeps): void => {
    router.get('/api/inboxes', ({res}) => {
        json(res, 200, {inboxes: service.listInboxes()});
    });

    router.get('/api/inbox', async ({res, url}) => {
        const project = requiredParam(url, 'project');
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
        const entries = await service.inboxCandidates(project, {limit});
        json(res, 200, {entries, total: service.inboxEntries(project).length});
    });

    router.post('/api/inbox/promote', async ({req, res, url}) => {
        const project = requiredParam(url, 'project');
        const body = await readJson<Record<string, unknown>>(req);
        const text = typeof body.content === 'string' ? body.content : undefined;
        try {
            const note = await service.promoteInboxEntry(project, refOf(body), targetOf(body.target), text);
            json(res, 200, {id: note.id, title: note.title, hash: note.hash});
        } catch (error) {
            throw mapError(error);
        }
    });

    router.post('/api/inbox/discard', async ({req, res, url}) => {
        const project = requiredParam(url, 'project');
        const body = await readJson<Record<string, unknown>>(req);
        try {
            await service.discardInboxEntry(project, refOf(body));
            json(res, 200, {discarded: true});
        } catch (error) {
            throw mapError(error);
        }
    });
};
