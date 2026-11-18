import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {SynaipseService} from '@synaipse/service';
import type {EventBroadcaster} from '../server/events.js';
import type {JobManager} from '../server/jobs.js';
import {routes} from '../server/routes.js';

/** Plan P8 S7: /api/inbox*, the backend of the Inbox tab. */

let vaultDir: string;
let service: SynaipseService;
let handler: ReturnType<typeof routes>;
const P = {project: 'demo'};

const call = async (method: string, url: string, body?: unknown): Promise<{status: number; body: Record<string, unknown>}> => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
    Object.assign(req, {method, url, headers: {'content-type': 'application/json'}});
    const out = {status: 0, body: {} as Record<string, unknown>};
    let sent = false;
    const res = {
        get headersSent() { return sent; },
        writeHead(status: number) { out.status = status; sent = true; return this; },
        setHeader() {},
        write() { return true; },
        end(chunk?: string | Buffer) {
            if (chunk !== undefined) out.body = JSON.parse(chunk.toString()) as Record<string, unknown>;
            return this;
        }
    } as unknown as ServerResponse;
    await handler(req, res, new URL(url, 'http://x'));
    return out;
};

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-inbox-routes-'));
    service = new SynaipseService({
        vaultPath: vaultDir,
        indexCachePath: path.join(vaultDir, '.cache.json'),
        chatStoreDir: path.join(vaultDir, '..', 'chats'),
        auditLogPath: path.join(vaultDir, '.audit.jsonl'),
        schedulesPath: path.join(vaultDir, '..', 'schedules.json'),
        embeddings: {provider: 'none' as const},
        qdrant: {url: 'http://127.0.0.1:9', collection: 'test'},
        server: {name: 'synaipse-test', version: '0.0.0'},
        web: {port: 0}
    });
    await service.start();
    handler = routes(service, {} as EventBroadcaster, {} as JobManager);
    await service.writeNote({path: 'howto/deploy.md', content: 'Deploys run on Tuesdays through the pipeline.', frontmatter: {title: 'Deploy process'}}, P);
    await service.appendInboxEntry('Deploys need a second approver in the pipeline.', ['deploy'], P);
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('/api/inbox', () => {
    it('lists projects and entries with targets', async () => {
        expect((await call('GET', '/api/inboxes')).body).toEqual({inboxes: [{project: 'demo', entries: 1}]});

        const {status, body} = await call('GET', '/api/inbox?project=demo');
        expect(status).toBe(200);
        expect(body.total).toBe(1);
        const [entry] = body.entries as Array<{text: string; tags: string[]; targets: Array<{id: string}>}>;
        expect(entry).toMatchObject({text: 'Deploys need a second approver in the pipeline.', tags: ['deploy']});
        expect(entry!.targets[0]!.id).toBe('Memory/demo/howto/deploy.md');
    });

    it('promotes with edited text, then the entry is gone; a stale ref is 409', async () => {
        const [entry] = (await call('GET', '/api/inbox?project=demo')).body.entries as Array<{inbox: string; time: string; text: string}>;
        const ref = {inbox: entry!.inbox, time: entry!.time, text: entry!.text};

        const promoted = await call('POST', '/api/inbox/promote?project=demo', {...ref, target: {id: 'Memory/demo/howto/deploy.md'}, content: 'Two approvers.'});
        expect(promoted.status).toBe(200);
        expect(promoted.body.id).toBe('Memory/demo/howto/deploy.md');
        expect(service.readNote('Memory/demo/howto/deploy.md').content).toContain('Two approvers.');
        expect((await call('GET', '/api/inboxes')).body).toEqual({inboxes: []});

        expect((await call('POST', '/api/inbox/discard?project=demo', ref)).status).toBe(409);
    });

    it('discards, and rejects bad bodies with 400', async () => {
        expect((await call('POST', '/api/inbox/discard?project=demo', {inbox: 'x'})).status).toBe(400);
        const [entry] = (await call('GET', '/api/inbox?project=demo')).body.entries as Array<{inbox: string; time: string; text: string}>;
        expect((await call('POST', '/api/inbox/promote?project=demo', {...entry, target: {}})).status).toBe(400);
        expect((await call('POST', '/api/inbox/discard?project=demo', {inbox: entry!.inbox, time: entry!.time, text: entry!.text})).body).toEqual({discarded: true});
        expect(service.inboxEntries('demo')).toEqual([]);
    });
});
