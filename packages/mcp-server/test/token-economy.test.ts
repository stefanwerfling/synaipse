import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SynaipseService} from '@synaipse/service';
import {buildTools, type ToolHandler} from '../src/Tools.js';
import {ageOf, extractSection} from '../src/Tools/Format.js';

/** Plan P2 / B3: brief write results, partial reads, title resolution, ISO times. */

const buildConfig = (vaultPath: string) => ({
    vaultPath,
    indexCachePath: path.join(vaultPath, '.cache.json'),
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    auditLogPath: path.join(vaultPath, '.audit.jsonl'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://localhost:6333', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0},
    project: {name: 'p'}
});

const writeNote = async (root: string, relPath: string, body: string): Promise<void> => {
    const absolute = path.join(root, relPath);
    await mkdir(path.dirname(absolute), {recursive: true});
    await writeFile(absolute, body, 'utf8');
};

const LONG = [
    '# Guide',
    'intro',
    '## Setup',
    'install it',
    '```',
    '## not a heading',
    '```',
    '### Details',
    'deep',
    '## Usage',
    'use it'
].join('\n');

let vaultDir: string;
let service: SynaipseService;
let tools: Map<string, ToolHandler>;

const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    const outcome = await tool.handle(args, {project: 'p'});
    return JSON.parse(outcome.response.content[0]!.text);
};

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-tokens-'));
    await writeNote(vaultDir, 'Memory/p/guide.md', `---\ntitle: The Guide\naliases: [handbook]\n---\n${LONG}`);
    await writeNote(vaultDir, 'Memory/p/other.md', '---\ntitle: Other\n---\nsee [[The Guide]]');
    service = new SynaipseService(buildConfig(vaultDir));
    await service.start();
    tools = new Map(buildTools(service).map((t) => [t.definition.name, t]));
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('read_note', () => {
    it('resolves a title or alias to the note id', async () => {
        expect((await call('synaipse_read_note', {id: 'The Guide'})).note.id).toBe('Memory/p/guide.md');
        expect((await call('synaipse_read_note', {id: 'handbook'})).note.id).toBe('Memory/p/guide.md');
    });

    it('fails with candidates when nothing matches', async () => {
        await expect(call('synaipse_read_note', {id: 'Guid'})).rejects.toThrow(/not found\. Did you mean "Memory\/p\/guide\.md"/);
    });

    it('returns only the requested section, ignoring headings inside code fences', async () => {
        const {note} = await call('synaipse_read_note', {id: 'Memory/p/guide.md', section: 'setup'});
        expect(note.content).toContain('install it');
        expect(note.content).toContain('### Details');
        expect(note.content).not.toContain('use it');
    });

    it('lists the headings when the section does not exist', async () => {
        await expect(call('synaipse_read_note', {id: 'Memory/p/guide.md', section: 'Nope'})).rejects.toThrow(/Headings: "Guide", "Setup"/);
    });

    it('pages long bodies with offset/maxChars and says where to continue', async () => {
        const first = (await call('synaipse_read_note', {id: 'Memory/p/guide.md', maxChars: 10})).note;
        expect(first.content).toBe(LONG.slice(0, 10));
        expect(first.range).toEqual({offset: 0, end: 10, total: LONG.length});
        expect(first.next).toBe('offset: 10');
        const second = (await call('synaipse_read_note', {id: 'Memory/p/guide.md', offset: 10, maxChars: 10})).note;
        expect(second.content).toBe(LONG.slice(10, 20));
    });

    it('reports ISO modified + age instead of epoch mtime and drops the duplicate path', async () => {
        const {note} = await call('synaipse_read_note', {id: 'Memory/p/guide.md'});
        expect(note.mtime).toBeUndefined();
        expect(note.path).toBeUndefined();
        expect(note.modified).toMatch(/^\d{4}-\d\d-\d\dT/);
        expect(note.age).toBeTypeOf('string');
    });
});

describe('write results', () => {
    it('write_note returns a brief result with dead-link warnings, not the note', async () => {
        const result = await call('synaipse_write_note', {path: 'new.md', content: 'links [[The Guide]] and [[Ghost]]'});
        expect(result).toMatchObject({id: 'Memory/p/new.md', hash: expect.any(String)});
        expect(result.content).toBeUndefined();
        expect(result.warnings).toEqual([expect.stringContaining('[[Ghost]]')]);
        expect(result.warnings[0]).not.toContain('The Guide');
    });

    it('update_note reports whether the stored note actually changed', async () => {
        const first = await call('synaipse_update_note', {id: 'Memory/p/other.md', content: 'new body'});
        expect(first.changed).toBe(true);
        const repeat = await call('synaipse_update_note', {id: 'Memory/p/other.md', content: 'new body'});
        expect(repeat.changed).toBe(false);
    });
});

describe('link_note', () => {
    it('stores the canonical title for an alias or path target', async () => {
        const result = await call('synaipse_link_note', {fromId: 'Memory/p/other.md', toTitles: ['handbook']});
        expect(result.added).toEqual(['The Guide']);
    });

    it('rejects targets that resolve to no note and links nothing', async () => {
        await expect(call('synaipse_link_note', {fromId: 'Memory/p/other.md', toTitles: ['The Guide', 'Ghost']}))
            .rejects.toThrow(/"Ghost"/);
        expect(service.readNote('Memory/p/other.md').content).not.toContain('References');
    });
});

describe('list times', () => {
    it('list carries modified + age', async () => {
        const {notes} = await call('synaipse_list', {limit: 1});
        expect(notes[0]).toMatchObject({modified: expect.stringMatching(/T/), age: expect.any(String)});
        expect(notes[0].mtime).toBeUndefined();
    });
});

describe('helpers', () => {
    it('ageOf buckets', () => {
        const now = 10 * 365 * 86_400_000;
        expect(ageOf(now - 30_000, now)).toBe('now');
        expect(ageOf(now - 5 * 60_000, now)).toBe('5m');
        expect(ageOf(now - 3 * 3_600_000, now)).toBe('3h');
        expect(ageOf(now - 12 * 86_400_000, now)).toBe('12d');
        expect(ageOf(now - 90 * 86_400_000, now)).toBe('3mo');
        expect(ageOf(now - 800 * 86_400_000, now)).toBe('2y');
    });

    it('extractSection returns null for a missing heading and runs to the end for the last one', () => {
        expect(extractSection(LONG, 'missing')).toBeNull();
        expect(extractSection(LONG, '## Usage')).toBe('## Usage\nuse it');
    });
});
