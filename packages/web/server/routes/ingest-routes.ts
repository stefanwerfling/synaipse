import {checkScope, resolveTokenScope} from '@synaipse/mcp-server';
import type {ChatgptImportConversation} from '@synaipse/service';
import {HttpError, badRequest, json, type Router} from '../router.js';
import {asString, errorMessage, readJson, type RouteDeps} from './shared.js';

interface ClipBody {
    url?: unknown;
    title?: unknown;
    html?: unknown;
    markdown?: unknown;
    selection?: unknown;
    tags?: unknown;
    excerpt?: unknown;
}

/** Web clipper, ChatGPT import and the Claude Code session log. */
export const registerIngestRoutes = (router: Router, {service, opts}: RouteDeps): void => {
    router.on('OPTIONS', '/api/clip', ({res}) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.writeHead(204);
        res.end();
    });

    router.post('/api/clip', async ({req, res}) => {
        // Permissive CORS so a browser extension content script can POST
        // without preflight gymnastics. The server only listens on localhost
        // so this is safe by default.
        res.setHeader('Access-Control-Allow-Origin', '*');

        // Bearer-auth gate. When no config was passed (test-invoke) or the
        // operator hasn't configured any tokens at all, we let requests
        // through anonymously — matches the zero-config dev-mode ergonomics
        // of the MCP surface. Once a token exists, the extension MUST
        // present one.
        if (opts.config !== undefined) {
            const server = opts.config.server;
            const hasAnyToken =
                (server.token !== undefined && server.token.length > 0)
                || (server.tokens !== undefined && server.tokens.length > 0);

            if (hasAnyToken) {
                const scope = await resolveTokenScope(req.headers.authorization, opts.config, null);
                if (scope === null) throw new HttpError(401, 'clip requires a valid Bearer token');

                const denial = checkScope(scope, {name: 'clip', mode: 'write'}, 'Clipped/');
                if (denial !== null) throw new HttpError(403, denial);
            }
        }

        const body = await readJson<ClipBody>(req);
        const url = asString(body.url, 'url');
        const title = asString(body.title, 'title');

        let markdown: string;

        if (typeof body.markdown === 'string' && body.markdown.length > 0) {
            markdown = body.markdown;
        } else if (typeof body.html === 'string' && body.html.length > 0) {
            const {default: TurndownService} = await import('turndown');
            const td = new TurndownService({headingStyle: 'atx', codeBlockStyle: 'fenced'});
            markdown = td.turndown(body.html);
        } else {
            throw badRequest("either 'markdown' or 'html' must be provided");
        }

        if (typeof body.selection === 'string' && body.selection.length > 0) {
            markdown = `> **Selection:**\n> \n> ${body.selection.replace(/\n/g, '\n> ')}\n\n---\n\n${markdown}`;
        }

        const tags = Array.isArray(body.tags)
            ? body.tags.filter((t): t is string => typeof t === 'string')
            : [];
        const excerpt = typeof body.excerpt === 'string' ? body.excerpt : undefined;

        try {
            json(res, 200, await service.clipPage({url, title, markdown, tags, ...(excerpt !== undefined ? {excerpt} : {})}));
        } catch (error) {
            throw new HttpError(500, String(error));
        }
    });

    router.get('/api/import/chatgpt/existing', ({res}) => {
        json(res, 200, Object.fromEntries(service.listChatgptImports()));
    });

    router.post('/api/import/chatgpt', async ({req, res}) => {
        const body = await readJson<{conversation?: unknown}>(req);
        const conv = body.conversation;

        if (typeof conv !== 'object' || conv === null) {
            throw badRequest("field 'conversation' must be object");
        }

        try {
            json(res, 200, await service.importChatgptConversation(conv as ChatgptImportConversation));
        } catch (error) {
            throw new HttpError(500, errorMessage(error));
        }
    });

    router.post('/api/sessions/log', async ({req, res}) => {
        const body = await readJson<{summary?: unknown; references?: unknown}>(req);
        const summary = asString(body.summary, 'summary');
        const references = Array.isArray(body.references)
            ? body.references.filter((r): r is string => typeof r === 'string')
            : [];

        json(res, 200, {sessionId: await service.appendSessionLog(summary, references)});
    });
};
