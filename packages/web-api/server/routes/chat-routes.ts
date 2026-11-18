import type {ChatSourceRef, ChatTurn} from '@synaipse/service';
import {HttpError, badRequest, json, type Router} from '../router.js';
import {asString, readJson, streamEvents, type RouteDeps} from './shared.js';

const parseTurns = (raw: unknown): ChatTurn[] => {
    if (!Array.isArray(raw)) {
        throw badRequest("field 'turns' must be an array");
    }

    const out: ChatTurn[] = [];

    for (const item of raw) {
        if (typeof item !== 'object' || item === null) continue;
        const t = item as Record<string, unknown>;
        if (t.role !== 'user' && t.role !== 'assistant') continue;
        if (typeof t.content !== 'string') continue;

        const turn: ChatTurn = {role: t.role, content: t.content};

        if (typeof t.model === 'string') turn.model = t.model;

        if (Array.isArray(t.sources)) {
            const sources: ChatSourceRef[] = [];
            for (const s of t.sources) {
                if (typeof s !== 'object' || s === null) continue;
                const src = s as Record<string, unknown>;
                if (typeof src.target !== 'string') continue;
                if (typeof src.title !== 'string') continue;
                if (typeof src.index !== 'number') continue;

                const ref: ChatSourceRef = {target: src.target, title: src.title, index: src.index};
                if (typeof src.score === 'number') ref.score = src.score;
                if (typeof src.snippet === 'string') ref.snippet = src.snippet;
                sources.push(ref);
            }
            if (sources.length > 0) turn.sources = sources;
        }

        out.push(turn);
    }

    return out;
};

const parseHistory = (raw: unknown): Array<{role: 'user' | 'assistant'; content: string}> => {
    const history: Array<{role: 'user' | 'assistant'; content: string}> = [];
    if (!Array.isArray(raw)) return history;

    for (const item of raw) {
        if (typeof item !== 'object' || item === null) continue;
        const {role, content} = item as Record<string, unknown>;
        if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
            history.push({role, content});
        }
    }

    return history;
};

interface ChatBody {
    title?: unknown;
    lastModel?: unknown;
    turns?: unknown;
}

const parseChatBody = (body: ChatBody): {title: string; turns: ChatTurn[]; lastModel?: string} => {
    const title = asString(body.title, 'title');
    const turns = parseTurns(body.turns);
    return typeof body.lastModel === 'string' ? {title, turns, lastModel: body.lastModel} : {title, turns};
};

/** Turns a service failure on a stored chat into `status` with its text. */
const as = (status: number) => (error: unknown): never => {
    if (error instanceof HttpError) throw error;
    throw new HttpError(status, String(error));
};

/** RAG chat, research and the stored chat sessions. */
export const registerChatRoutes = (router: Router, {service}: RouteDeps): void => {
    router.post('/api/chat/preview', async ({req, res}) => {
        const body = await readJson<{question?: unknown; pathPrefix?: unknown}>(req);
        const question = asString(body.question, 'question');
        const pathPrefix = typeof body.pathPrefix === 'string' ? body.pathPrefix : undefined;

        json(res, 200, await service.chatPreview({question, ...(pathPrefix !== undefined ? {pathPrefix} : {})}));
    });

    router.post('/api/chat', async ({req, res}) => {
        const body = await readJson<{question?: unknown; pathPrefix?: unknown; history?: unknown}>(req);
        const question = asString(body.question, 'question');
        const pathPrefix = typeof body.pathPrefix === 'string' ? body.pathPrefix : undefined;
        const history = parseHistory(body.history);

        await streamEvents(req, res, (abort) => service.chat({
            question,
            ...(pathPrefix !== undefined ? {pathPrefix} : {}),
            ...(history.length > 0 ? {history} : {}),
            abort
        }));
    });

    router.post('/api/research', async ({req, res}) => {
        const body = await readJson<{question?: unknown}>(req);
        const question = asString(body.question, 'question');

        await streamEvents(req, res, (abort) => service.research(question, {abort}));
    });

    router.get('/api/chats', async ({res}) => {
        json(res, 200, await service.listChats());
    });

    router.post('/api/chats', async ({req, res}) => {
        const input = parseChatBody(await readJson<ChatBody>(req));
        json(res, 201, await service.createChat(input).catch(as(400)));
    });

    // Promote a stored chat into a real vault note. Body is empty / optional.
    router.post('/api/chats/:id+/save-as-note', async ({res, params}) => {
        const noteId = await service.saveChatAsNote(params.id as string).catch(as(400));
        json(res, 201, {noteId});
    });

    router.get('/api/chats/:id+', async ({res, params}) => {
        json(res, 200, await service.getChat(params.id as string).catch(as(404)));
    });

    router.put('/api/chats/:id+', async ({req, res, params}) => {
        const input = parseChatBody(await readJson<ChatBody>(req));
        json(res, 200, await service.updateChat(params.id as string, input).catch(as(400)));
    });

    router.delete('/api/chats/:id+', async ({res, params}) => {
        await service.deleteChat(params.id as string).catch(as(400));
        json(res, 200, {ok: true});
    });
};
