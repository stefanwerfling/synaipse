import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SynaipseService, auditContextStorage} from '@synaipse/service';
import {buildTools, EMPTY_CTX} from '../src/Tools.js';

const buildConfig = (vaultPath: string, indexCachePath: string) => ({
    vaultPath,
    indexCachePath,
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    auditLogPath: path.join(vaultPath, '.audit.jsonl'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://localhost:6333', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0}
});

const writeNote = async (root: string, relPath: string, body: string): Promise<void> => {
    const absolute = path.join(root, relPath);
    await mkdir(path.dirname(absolute), {recursive: true});
    await writeFile(absolute, body, 'utf8');
};

let vaultDir: string;
let service: SynaipseService;
let tools: ReturnType<typeof buildTools>;

const findTool = (name: string): (typeof tools)[number] => {
    const t = tools.find((x) => x.definition.name === name);
    if (t === undefined) throw new Error(`tool ${name} not found`);
    return t;
};

const parse = <T = unknown>(text: string): T => JSON.parse(text) as T;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-consent-'));
    service = new SynaipseService(buildConfig(vaultDir, path.join(vaultDir, '.cache.json')));
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

const setup = async (): Promise<void> => {
    await service.start();
    tools = buildTools(service);
};

describe('MCP consent gate — synaipse_read_note', () => {
    it('passes through when frontmatter has no mcp_consent field', async () => {
        await writeNote(vaultDir, 'plain.md', '---\ntitle: Plain\n---\nbody');
        await setup();

        const outcome = await findTool('synaipse_read_note').handle({id: 'plain.md'}, EMPTY_CTX);
        const payload = parse<{note: {title: string}}>(outcome.response.content[0]!.text);
        expect(payload.note.title).toBe('Plain');
    });

    it('passes through when mcp_consent is "granted"', async () => {
        await writeNote(vaultDir, 'ok.md', '---\ntitle: OK\nmcp_consent: granted\n---\nbody');
        await setup();

        const outcome = await findTool('synaipse_read_note').handle({id: 'ok.md'}, EMPTY_CTX);
        const payload = parse<{note: {title: string}}>(outcome.response.content[0]!.text);
        expect(payload.note.title).toBe('OK');
    });

    it('throws when mcp_consent is "denied"', async () => {
        await writeNote(vaultDir, 'no.md', '---\ntitle: No\nmcp_consent: denied\n---\nbody');
        await setup();

        await expect(findTool('synaipse_read_note').handle({id: 'no.md'}, EMPTY_CTX))
            .rejects.toThrow(/denied/i);
    });

    it('long-polls on "pending" — resolving with "granted" returns the note', async () => {
        await writeNote(vaultDir, 'wait.md', '---\ntitle: Wait\nmcp_consent: pending\n---\nbody');
        await setup();

        const p = auditContextStorage.run(
            {tokenLabel: 'test-token'},
            () => findTool('synaipse_read_note').handle({id: 'wait.md'}, EMPTY_CTX)
        );

        // give the handler a tick to register the pending request
        await new Promise((r) => setTimeout(r, 20));
        const [pending] = service.getConsentStore().pending();
        expect(pending?.noteId).toBe('wait.md');
        expect(pending?.requester).toBe('test-token');

        await service.resolveConsent(pending!.id, 'granted');

        const outcome = await p;
        const payload = parse<{note: {title: string; frontmatter: {mcp_consent?: string}}}>(
            outcome.response.content[0]!.text
        );
        expect(payload.note.title).toBe('Wait');
        expect(payload.note.frontmatter.mcp_consent).toBe('granted');
    });

    it('long-polls on "pending" — resolving with "denied" throws', async () => {
        await writeNote(vaultDir, 'nope.md', '---\ntitle: Nope\nmcp_consent: pending\n---\nbody');
        await setup();

        // Attach the catch handler synchronously so the eventual rejection
        // is never "unhandled" from Vitest's perspective, no matter when
        // the resolve fires vs. our await.
        const captured: {err?: Error} = {};
        const done = auditContextStorage.run(
            {tokenLabel: 'x'},
            () => findTool('synaipse_read_note').handle({id: 'nope.md'}, EMPTY_CTX)
        ).catch((e: unknown) => {
            captured.err = e instanceof Error ? e : new Error(String(e));
        });

        await new Promise((r) => setTimeout(r, 20));
        const [pending] = service.getConsentStore().pending();
        await service.resolveConsent(pending!.id, 'denied');
        await done;

        expect(captured.err).toBeInstanceOf(Error);
        expect(captured.err?.message).toMatch(/denied/i);
    });
});

describe('MCP consent filter — aggregate tools', () => {
    it('synaipse_list_notes skips pending/denied notes and reports skip count', async () => {
        await writeNote(vaultDir, 'ok.md', '---\ntitle: OK\n---\nbody');
        await writeNote(vaultDir, 'granted.md', '---\ntitle: Granted\nmcp_consent: granted\n---\nbody');
        await writeNote(vaultDir, 'pending.md', '---\ntitle: Pending\nmcp_consent: pending\n---\nbody');
        await writeNote(vaultDir, 'denied.md', '---\ntitle: Denied\nmcp_consent: denied\n---\nbody');
        await setup();

        const outcome = await findTool('synaipse_list_notes').handle({}, EMPTY_CTX);
        const payload = parse<{notes: Array<{id: string}>; skippedByConsent?: number}>(
            outcome.response.content[0]!.text
        );
        const ids = payload.notes.map((n) => n.id).sort();
        expect(ids).toEqual(['granted.md', 'ok.md']);
        expect(payload.skippedByConsent).toBe(2);
    });

    it('synaipse_todos silently drops todos from pending/denied notes', async () => {
        await writeNote(vaultDir, 'visible.md', '---\ntitle: Visible\n---\n- [ ] do the thing');
        await writeNote(vaultDir, 'blocked.md',
            '---\ntitle: Blocked\nmcp_consent: pending\n---\n- [ ] leak me');
        await setup();

        const outcome = await findTool('synaipse_todos').handle({}, EMPTY_CTX);
        const payload = parse<{todos: Array<{noteId: string; text: string}>; skippedByConsent?: number}>(
            outcome.response.content[0]!.text
        );
        expect(payload.todos.map((t) => t.noteId)).toEqual(['visible.md']);
        expect(payload.skippedByConsent).toBe(1);
    });

    it('omits skippedByConsent from response when nothing is skipped', async () => {
        await writeNote(vaultDir, 'a.md', '---\ntitle: A\n---\nbody');
        await setup();

        const outcome = await findTool('synaipse_list_notes').handle({}, EMPTY_CTX);
        const payload = parse<{skippedByConsent?: number}>(outcome.response.content[0]!.text);
        expect(payload.skippedByConsent).toBeUndefined();
    });
});