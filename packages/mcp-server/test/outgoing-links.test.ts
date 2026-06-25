import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SynaipseService} from '@synaipse/service';
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
let outgoing: ReturnType<typeof buildTools>[number];

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-tool-outgoing-'));
    service = new SynaipseService(buildConfig(vaultDir, path.join(vaultDir, '.cache.json')));
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

const setupTool = async (): Promise<void> => {
    await service.start();
    const tool = buildTools(service).find((t) => t.definition.name === 'synaipse_outgoing_links');
    if (tool === undefined) throw new Error('synaipse_outgoing_links tool not registered');
    outgoing = tool;
};

describe('synaipse_outgoing_links tool', () => {
    it('returns body wikilinks and empty typed list when no frontmatter links', async () => {
        await writeNote(vaultDir, 'src.md', '---\ntitle: Src\n---\nrefs [[Foo]] and [[Bar]]');
        await writeNote(vaultDir, 'foo.md', '---\ntitle: Foo\n---\nbody');
        await writeNote(vaultDir, 'bar.md', '---\ntitle: Bar\n---\nbody');
        await setupTool();

        const outcome = await outgoing.handle({id: 'src.md'}, EMPTY_CTX);
        const payload = JSON.parse(outcome.response.content[0]!.text);

        expect(payload.wikilinks.sort()).toEqual(['Bar', 'Foo']);
        expect(payload.typed).toEqual([]);
    });

    it('surfaces well-formed typed links from frontmatter', async () => {
        await writeNote(vaultDir, 'new.md',
            '---\ntitle: New\nlinks:\n  - target: Old\n    kind: supersedes\n  - target: Related\n    kind: relates_to\n---\nbody'
        );
        await writeNote(vaultDir, 'old.md', '---\ntitle: Old\n---\nbody');
        await writeNote(vaultDir, 'related.md', '---\ntitle: Related\n---\nbody');
        await setupTool();

        const outcome = await outgoing.handle({id: 'new.md'}, EMPTY_CTX);
        const payload = JSON.parse(outcome.response.content[0]!.text);

        expect(payload.typed).toEqual([
            {target: 'Old', kind: 'supersedes'},
            {target: 'Related', kind: 'relates_to'}
        ]);
    });

    it('silently skips malformed typed-link entries', async () => {
        // unknown kind + missing target + valid entry
        await writeNote(vaultDir, 'mix.md',
            '---\ntitle: Mix\nlinks:\n  - target: A\n    kind: cites\n  - kind: supersedes\n  - target: Good\n    kind: replies_to\n---\nbody'
        );
        await setupTool();

        const outcome = await outgoing.handle({id: 'mix.md'}, EMPTY_CTX);
        const payload = JSON.parse(outcome.response.content[0]!.text);

        expect(payload.typed).toEqual([{target: 'Good', kind: 'replies_to'}]);
    });

    it('body wikilinks and typed links are independent surfaces', async () => {
        await writeNote(vaultDir, 'both.md',
            '---\ntitle: Both\nlinks:\n  - target: Other\n    kind: supersedes\n---\nbody mentions [[InlineOnly]]'
        );
        await setupTool();

        const outcome = await outgoing.handle({id: 'both.md'}, EMPTY_CTX);
        const payload = JSON.parse(outcome.response.content[0]!.text);

        expect(payload.wikilinks).toEqual(['InlineOnly']);
        expect(payload.typed).toEqual([{target: 'Other', kind: 'supersedes'}]);
    });
});