import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {createServer, request, type IncomingMessage, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadConfigFromEnv} from '@synaipse/core';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {startSynaipseEmbed, type SynaipseEmbedHandle} from '../server/embed.js';

/**
 * Plan P3 / E2: the backend contract for embedding hosts. Configuration
 * is passed explicitly (an env object, never process.env), handlers work
 * before startup finished, a body the host already parsed is accepted,
 * and close() ends everything.
 */

let dir: string;
let handle: SynaipseEmbedHandle | null = null;
let server: Server | null = null;

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'synaipse-embed-'));
    await writeFile(path.join(dir, 'Start.md'), '---\ntitle: Start\n---\nhello\n', 'utf8');
});

afterEach(async () => {
    await handle?.close();
    handle = null;
    await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())));
    server = null;
    await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 20});
});

const explicitEnv = (): NodeJS.ProcessEnv => ({
    SYNAIPSE_VAULT_PATH: dir,
    EMBEDDINGS_PROVIDER: 'none',
    SYNAIPSE_MCP_PATH: '/mcp'
});

/** Host server; `preParse` imitates express.json() mounted before Synaipse. */
const listen = async (h: SynaipseEmbedHandle, preParse = false): Promise<string> => {
    server = createServer((req, res) => {
        void (async () => {
            if (preParse && req.method !== 'GET') {
                const chunks: Buffer[] = [];
                for await (const chunk of req) chunks.push(chunk as Buffer);
                const r = req as IncomingMessage & {body?: unknown; _body?: boolean};
                r.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                r._body = true;
            }
            const url = new URL(req.url ?? '/', 'http://host');
            if (url.pathname.startsWith(h.mcpBasePath)) {
                h.mcpHandler(req, res);
                return;
            }
            await h.apiHandle(req, res, url);
        })();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
};

describe('startSynaipseEmbed', () => {
    it('mcpRegistrar puts the tools on a host gateway once started (plan P9 / E2)', async () => {
        handle = startSynaipseEmbed({env: explicitEnv()});
        const session = async (): Promise<Client> => {
            const gateway = new McpServer({name: 'host', version: '0'});
            handle!.mcpRegistrar(gateway);
            const [c, s] = InMemoryTransport.createLinkedPair();
            const client = new Client({name: 't', version: '0'});
            await Promise.all([gateway.connect(s), client.connect(c)]);
            return client;
        };

        const early = await session();
        expect(await early.listTools().then((r) => r.tools.length, () => 0)).toBe(0);
        await early.close();

        await handle.ready;
        const client = await session();
        const result = await client.callTool({name: 'synaipse_read_note', arguments: {id: 'Start.md'}});
        expect((result.content as Array<{text: string}>)[0]!.text).toContain('hello');
        await client.close();
    });

    it('answers 503 + Retry-After while starting, then serves the explicitly configured vault', async () => {
        handle = startSynaipseEmbed({env: explicitEnv()});
        const base = await listen(handle);

        expect(handle.health()).toEqual({status: 'starting'});
        const early = await fetch(`${base}/api/notes`);
        expect(early.status).toBe(503);
        expect(early.headers.get('retry-after')).toBe('1');

        await handle.ready;
        expect(handle.health()).toEqual({status: 'ready', notes: 1, mode: 'local'});
        const notes = await (await fetch(`${base}/api/notes`)).json() as {id: string}[];
        expect(notes.map((n) => n.id)).toEqual(['Start.md']);
    });

    it('accepts a full Config object instead of env', async () => {
        handle = startSynaipseEmbed({config: loadConfigFromEnv(explicitEnv()), env: {}});
        await handle.ready;
        expect(handle.health()).toMatchObject({status: 'ready', notes: 1});
    });

    it('works when the host already consumed and parsed the body (express.json first)', async () => {
        handle = startSynaipseEmbed({env: explicitEnv()});
        const base = await listen(handle, true);
        await handle.ready;

        const res = await fetch(`${base}/api/notes/${encodeURIComponent('Neu.md')}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({content: '---\ntitle: Neu\n---\nparsed by the host\n'}),
            signal: AbortSignal.timeout(5000)
        });
        expect(res.status).toBe(200);
        expect(await readFile(path.join(dir, 'Neu.md'), 'utf8')).toContain('parsed by the host');
    });

    it('reports a failed start instead of hanging', async () => {
        handle = startSynaipseEmbed({env: {...explicitEnv(), EMBEDDINGS_PROVIDER: 'no-such-provider'}});
        const base = await listen(handle);
        await expect(handle.ready).rejects.toThrow();
        expect(handle.health().status).toBe('failed');
        expect((await fetch(`${base}/api/notes`)).status).toBe(500);
    });

    it('consent requests ride on the event stream, open ones replayed on connect', async () => {
        handle = startSynaipseEmbed({env: explicitEnv()});
        const base = await listen(handle);
        const {service} = await handle.ready;
        const consent = service.getConsentStore();
        void consent.request('Before.md', 'tok-a', 5000);

        let body = '';
        const stream = request(`${base}/api/events/stream`, (res) => res.on('data', (c: Buffer) => { body += c.toString(); }));
        stream.on('error', () => undefined);
        stream.end();
        const waitFor = async (needle: string): Promise<void> => {
            for (let i = 0; i < 100 && !body.includes(needle); i++) await new Promise((r) => setTimeout(r, 20));
            expect(body).toContain(needle);
        };

        await waitFor('"noteId":"Before.md"');
        expect(body).toMatch(/event: consent-new\ndata: \{[^\n]*"noteId":"Before\.md"/);

        void consent.request('Live.md', 'tok-b', 5000);
        await waitFor('"noteId":"Live.md"');
        const live = consent.pending().find((r) => r.noteId === 'Live.md');
        const res = await fetch(`${base}/api/consent/${encodeURIComponent(live!.id)}/approve`, {method: 'POST'});
        expect(res.status).toBe(200);
        await waitFor('event: consent-resolved');
        expect(body).toMatch(/event: consent-resolved\ndata: \{[^\n]*"noteId":"Live\.md"[^\n]*"decision":"granted"/);
        stream.destroy();
    });

    for (const [verb, decision] of [['approve', 'granted'], ['deny', 'denied']] as const) {
        it(`POST /api/consent/:id/${verb} stores "${decision}" (frontmatter and the waiting MCP read)`, async () => {
            await writeFile(path.join(dir, 'Secret.md'), '---\ntitle: Secret\nmcp_consent: pending\n---\nprivate\n', 'utf8');
            handle = startSynaipseEmbed({env: explicitEnv()});
            const base = await listen(handle);
            const {service} = await handle.ready;
            const consent = service.getConsentStore();
            const waiting = consent.request('Secret.md', 'tok', 5000);
            const id = consent.pending()[0]!.id;

            const res = await fetch(`${base}/api/consent/${encodeURIComponent(id)}/${verb}`, {method: 'POST'});
            expect(res.status).toBe(200);
            expect(((await res.json()) as {request: {decision: string}}).request.decision).toBe(decision);
            expect(await waiting).toBe(decision);
            expect(await readFile(path.join(dir, 'Secret.md'), 'utf8')).toContain(`mcp_consent: ${decision}`);
        });
    }

    it('close() ends open SSE streams and stops answering', async () => {
        handle = startSynaipseEmbed({env: explicitEnv()});
        const base = await listen(handle);
        await handle.ready;

        const ended = new Promise<void>((resolve, reject) => {
            const req = request(`${base}/api/events/stream`, (res) => {
                res.on('data', () => undefined);
                res.on('end', () => resolve());
            });
            req.on('error', reject);
            req.end();
        });
        await new Promise((r) => setTimeout(r, 100));

        await handle.close();
        await ended;
        expect(handle.health()).toEqual({status: 'closed'});
        expect((await fetch(`${base}/api/notes`)).status).toBe(503);
        await handle.close(); // idempotent
    });
});
