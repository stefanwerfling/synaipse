import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {mkdtemp, rm, writeFile, mkdir, readFile, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {SearchHit} from '@synaipse/core';
import {SynaipseService} from '../src/Service.js';
import type {ChatEvent} from '../src/Chat.js';

const buildConfig = (vaultPath: string, indexCachePath: string) => ({
    vaultPath,
    indexCachePath,
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://localhost:6333', collection: 'test'},
    server: {name: 'synaipse-test', version: '0.0.0'},
    web: {port: 0}
});

const buildProjectConfig = (vaultPath: string, indexCachePath: string, project = 'test') => ({
    ...buildConfig(vaultPath, indexCachePath),
    project: {name: project}
});

const writeNote = async (root: string, relPath: string, body: string): Promise<void> => {
    const absolute = path.join(root, relPath);
    await mkdir(path.dirname(absolute), {recursive: true});
    await writeFile(absolute, body, 'utf8');
};

let vaultDir: string;
let cacheFile: string;
let service: SynaipseService;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-svc-'));
    cacheFile = path.join(vaultDir, '.cache.json');
});

afterEach(async () => {
    await service.stop();
    await rm(vaultDir, {recursive: true, force: true});
});

describe('SynaipseService.related', () => {
    it('finds notes via tag overlap and wikilinks', async () => {
        await writeNote(vaultDir, 'a.md', '---\ntitle: A\ntags: [auth, ts]\n---\nLinks to [[B]] and [[C]].');
        await writeNote(vaultDir, 'b.md', '---\ntitle: B\ntags: [auth, ts]\n---\nrelated to A');
        await writeNote(vaultDir, 'c.md', '---\ntitle: C\ntags: [auth]\n---\nrelated to A');
        await writeNote(vaultDir, 'd.md', '---\ntitle: D\ntags: [unrelated]\n---\nnope');

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const related = await service.related('a.md', 10);
        const ids = related.map((r) => r.id);

        expect(ids).toContain('b.md');
        expect(ids).toContain('c.md');
        expect(ids).not.toContain('d.md');
        expect(ids).not.toContain('a.md');

        const b = related.find((r) => r.id === 'b.md');
        const c = related.find((r) => r.id === 'c.md');
        expect(b?.score ?? 0).toBeGreaterThan(c?.score ?? 0);
        expect(b?.reasons).toContain('wikilink-out');
    });

    it('returns empty for unknown id', async () => {
        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();
        expect(await service.related('missing.md', 10)).toEqual([]);
    });
});

describe('SynaipseService.todos', () => {
    it('collects open todos and respects includeDone', async () => {
        await writeNote(vaultDir, 'todo.md', '# todos\n\n- [ ] open one\n- [x] done one\n- [ ] open two');
        await writeNote(vaultDir, 'plain.md', 'no todos here');

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const open = service.todos();
        expect(open.length).toBe(2);
        expect(open.map((t) => t.text).sort()).toEqual(['open one', 'open two']);
        expect(open.every((t) => !t.done)).toBe(true);

        const all = service.todos('', true);
        expect(all.length).toBe(3);
        expect(all.some((t) => t.done && t.text === 'done one')).toBe(true);
    });

    it('filters by path prefix', async () => {
        await writeNote(vaultDir, 'sub/x.md', '- [ ] keep me');
        await writeNote(vaultDir, 'other.md', '- [ ] skip me');

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const todos = service.todos('sub/');
        expect(todos.length).toBe(1);
        expect(todos[0]?.text).toBe('keep me');
    });

    it('reports correct line numbers', async () => {
        await writeNote(vaultDir, 'pos.md', 'line 1\nline 2\n- [ ] task on line 3\nline 4');

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const [todo] = service.todos();
        expect(todo?.line).toBe(3);
    });
});

describe('SynaipseService.linkNote', () => {
    it('appends a new References section when missing', async () => {
        await writeNote(vaultDir, 'Memory/test/src.md', '---\ntitle: Source\n---\nbody text');
        await writeNote(vaultDir, 'Memory/test/tgt.md', '---\ntitle: Target\n---\nother');

        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile));
        await service.start();

        const {added} = await service.linkNote('Memory/test/src.md', ['Target']);
        expect(added).toEqual(['Target']);

        const content = await readFile(path.join(vaultDir, 'Memory/test/src.md'), 'utf8');
        expect(content).toMatch(/## References/);
        expect(content).toMatch(/\[\[Target\]\]/);
    });

    it('is idempotent for existing wikilinks', async () => {
        await writeNote(vaultDir, 'Memory/test/src.md', '---\ntitle: Source\n---\nbody\n\n## References\n\n- [[Target]]\n');
        await writeNote(vaultDir, 'Memory/test/tgt.md', '---\ntitle: Target\n---\nother');

        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile));
        await service.start();

        const {added} = await service.linkNote('Memory/test/src.md', ['Target']);
        expect(added).toEqual([]);
    });

    it('inserts into existing section without duplicates', async () => {
        await writeNote(vaultDir, 'Memory/test/src.md', '---\ntitle: Source\n---\nbody\n\n## References\n\n- [[Existing]]\n');

        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile));
        await service.start();

        const {added} = await service.linkNote('Memory/test/src.md', ['Existing', 'New']);
        expect(added).toEqual(['New']);

        const content = await readFile(path.join(vaultDir, 'Memory/test/src.md'), 'utf8');
        expect((content.match(/\[\[Existing\]\]/g) ?? []).length).toBe(1);
        expect(content).toMatch(/\[\[New\]\]/);
    });

    it('supports custom section name', async () => {
        await writeNote(vaultDir, 'Memory/test/src.md', '---\ntitle: Source\n---\nbody');

        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile));
        await service.start();

        await service.linkNote('Memory/test/src.md', ['Other'], 'See also');

        const content = await readFile(path.join(vaultDir, 'Memory/test/src.md'), 'utf8');
        expect(content).toMatch(/## See also/);
    });
});

describe('SynaipseService.updateNote', () => {
    it('shallow-merges frontmatter without touching content', async () => {
        await writeNote(vaultDir, 'Memory/test/n.md', '---\ntitle: Original\ntags: [old]\n---\noriginal body');

        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile));
        await service.start();

        const updated = await service.updateNote('Memory/test/n.md', {
            frontmatterPatch: {tags: ['new'], status: 'draft'}
        });

        expect(updated.frontmatter.title).toBe('Original');
        expect(updated.frontmatter.tags).toEqual(expect.arrayContaining(['new', 'project/test']));
        expect(updated.frontmatter['status']).toBe('draft');
        expect(updated.content).toContain('original body');
    });

    it('updates content while keeping frontmatter', async () => {
        await writeNote(vaultDir, 'Memory/test/n.md', '---\ntitle: Stay\n---\nold body');

        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile));
        await service.start();

        const updated = await service.updateNote('Memory/test/n.md', {content: 'new body'});
        expect(updated.frontmatter.title).toBe('Stay');
        expect(updated.content).toContain('new body');
        expect(updated.content).not.toContain('old body');
    });
});

describe('SynaipseService.suggestLinks', () => {
    it('suggests pairs with >=2 shared tags and no wikilink between them', async () => {
        await writeNote(vaultDir, 'a.md', '---\ntitle: A\ntags: [auth, security]\n---\nfoo');
        await writeNote(vaultDir, 'b.md', '---\ntitle: B\ntags: [auth, security]\n---\nbar');
        await writeNote(vaultDir, 'c.md', '---\ntitle: C\ntags: [auth]\n---\nonly one shared');
        await writeNote(vaultDir, 'd.md', '---\ntitle: D\ntags: [unrelated]\n---\nnope');

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const suggestions = await service.suggestLinks();
        const pair = suggestions.find((s) =>
            (s.a === 'a.md' && s.b === 'b.md') || (s.a === 'b.md' && s.b === 'a.md')
        );

        expect(pair).toBeDefined();
        expect(pair?.reasons).toContain('tag-overlap');
        expect(pair?.sharedTags?.sort()).toEqual(['auth', 'security']);

        const cPair = suggestions.find((s) => s.a === 'c.md' || s.b === 'c.md');
        expect(cPair).toBeUndefined();

        const dPair = suggestions.find((s) => s.a === 'd.md' || s.b === 'd.md');
        expect(dPair).toBeUndefined();
    });

    it('excludes pairs already connected by a wikilink in either direction', async () => {
        await writeNote(vaultDir, 'a.md', '---\ntitle: A\ntags: [auth, ts]\n---\nlinks to [[B]]');
        await writeNote(vaultDir, 'b.md', '---\ntitle: B\ntags: [auth, ts]\n---\nno outgoing link');
        await writeNote(vaultDir, 'c.md', '---\ntitle: C\ntags: [auth, ts]\n---\nlinks to [[A]]');

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const suggestions = await service.suggestLinks();

        for (const s of suggestions) {
            const involvesA = s.a === 'a.md' || s.b === 'a.md';
            const involvesB = s.a === 'b.md' || s.b === 'b.md';
            const involvesC = s.a === 'c.md' || s.b === 'c.md';

            expect(involvesA && involvesB).toBe(false);
            expect(involvesA && involvesC).toBe(false);
        }

        const bcPair = suggestions.find((s) =>
            (s.a === 'b.md' && s.b === 'c.md') || (s.a === 'c.md' && s.b === 'b.md')
        );
        expect(bcPair).toBeDefined();
    });

    it('respects pathPrefix and excludes notes outside it', async () => {
        await writeNote(vaultDir, 'inside/a.md', '---\ntitle: A\ntags: [auth, ts]\n---\nfoo');
        await writeNote(vaultDir, 'inside/b.md', '---\ntitle: B\ntags: [auth, ts]\n---\nbar');
        await writeNote(vaultDir, 'outside.md', '---\ntitle: C\ntags: [auth, ts]\n---\nelsewhere');

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const suggestions = await service.suggestLinks({pathPrefix: 'inside/'});
        expect(suggestions.length).toBe(1);
        for (const s of suggestions) {
            expect(s.a.startsWith('inside/')).toBe(true);
            expect(s.b.startsWith('inside/')).toBe(true);
        }
    });

    it('honours the limit option', async () => {
        await writeNote(vaultDir, 'a.md', '---\ntitle: A\ntags: [x, y]\n---\nfoo');
        await writeNote(vaultDir, 'b.md', '---\ntitle: B\ntags: [x, y]\n---\nbar');
        await writeNote(vaultDir, 'c.md', '---\ntitle: C\ntags: [x, y]\n---\nbaz');

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const all = await service.suggestLinks();
        expect(all.length).toBeGreaterThanOrEqual(2);

        const capped = await service.suggestLinks({limit: 1});
        expect(capped.length).toBe(1);
    });

    it('returns empty for a vault with fewer than 2 notes', async () => {
        await writeNote(vaultDir, 'only.md', '---\ntitle: Only\ntags: [a, b]\n---\nlonely');

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const suggestions = await service.suggestLinks();
        expect(suggestions).toEqual([]);
    });

    it('sorts suggestions by score descending', async () => {
        await writeNote(vaultDir, 'a.md', '---\ntitle: A\ntags: [t1, t2, t3, t4]\n---\nbody');
        await writeNote(vaultDir, 'b.md', '---\ntitle: B\ntags: [t1, t2, t3, t4]\n---\nshares 4 with A');
        await writeNote(vaultDir, 'c.md', '---\ntitle: C\ntags: [t1, t2]\n---\nshares 2 with A');

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const suggestions = await service.suggestLinks();
        expect(suggestions.length).toBeGreaterThanOrEqual(2);

        for (let i = 0; i < suggestions.length - 1; i++) {
            const cur = suggestions[i];
            const next = suggestions[i + 1];

            if (cur !== undefined && next !== undefined) {
                expect(cur.score).toBeGreaterThanOrEqual(next.score);
            }
        }
    });
});

describe('SynaipseService.staleNotes', () => {
    const ageFile = async (vault: string, relPath: string, daysAgo: number): Promise<void> => {
        const abs = path.join(vault, relPath);
        const when = new Date(Date.now() - daysAgo * 86_400_000);
        await utimes(abs, when, when);
    };

    it('returns notes whose mtime is older than the threshold', async () => {
        await writeNote(vaultDir, 'old.md', '---\ntitle: Old\n---\nbody');
        await writeNote(vaultDir, 'new.md', '---\ntitle: New\n---\nbody');
        await ageFile(vaultDir, 'old.md', 200);
        await ageFile(vaultDir, 'new.md', 5);

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const stale = service.staleNotes({olderThanDays: 90});
        const ids = stale.map((s) => s.id);

        expect(ids).toContain('old.md');
        expect(ids).not.toContain('new.md');

        const oldEntry = stale.find((s) => s.id === 'old.md');
        expect(oldEntry?.ageDays).toBeGreaterThanOrEqual(199);
        expect(oldEntry?.accessCount).toBe(0);
    });

    it('readNote bumps lastAccessed so an old note no longer counts as stale', async () => {
        await writeNote(vaultDir, 'old.md', '---\ntitle: Old\n---\nbody');
        await ageFile(vaultDir, 'old.md', 200);

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        expect(service.staleNotes({olderThanDays: 90}).length).toBe(1);

        service.readNote('old.md');

        expect(service.staleNotes({olderThanDays: 90}).length).toBe(0);
    });

    it('search bumps lastAccessed for every hit', async () => {
        await writeNote(vaultDir, 'old.md', '---\ntitle: Old\n---\nunique-token body');
        await ageFile(vaultDir, 'old.md', 200);

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        await service.search('unique-token', 'fulltext', 5);

        expect(service.staleNotes({olderThanDays: 90}).length).toBe(0);
    });

    it('respects pathPrefix', async () => {
        await writeNote(vaultDir, 'inside/a.md', '---\ntitle: A\n---\nbody');
        await writeNote(vaultDir, 'outside.md', '---\ntitle: B\n---\nbody');
        await ageFile(vaultDir, 'inside/a.md', 200);
        await ageFile(vaultDir, 'outside.md', 200);

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const stale = service.staleNotes({olderThanDays: 90, pathPrefix: 'inside/'});
        const ids = stale.map((s) => s.id);

        expect(ids).toContain('inside/a.md');
        expect(ids).not.toContain('outside.md');
    });

    it('sorts by ageDays descending and honours limit', async () => {
        await writeNote(vaultDir, 'a.md', '---\ntitle: A\n---\nbody');
        await writeNote(vaultDir, 'b.md', '---\ntitle: B\n---\nbody');
        await writeNote(vaultDir, 'c.md', '---\ntitle: C\n---\nbody');
        await ageFile(vaultDir, 'a.md', 100);
        await ageFile(vaultDir, 'b.md', 300);
        await ageFile(vaultDir, 'c.md', 200);

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const stale = service.staleNotes({olderThanDays: 90});
        expect(stale.map((s) => s.id)).toEqual(['b.md', 'c.md', 'a.md']);

        const capped = service.staleNotes({olderThanDays: 90, limit: 1});
        expect(capped.length).toBe(1);
        expect(capped[0]?.id).toBe('b.md');
    });

    it('uses max(mtime, lastAccessed) so a recently-accessed old note is fresh', async () => {
        await writeNote(vaultDir, 'x.md', '---\ntitle: X\n---\nbody');
        await ageFile(vaultDir, 'x.md', 200);

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        service.readNote('x.md');

        const all = service.staleNotes({olderThanDays: 0});
        const entry = all.find((s) => s.id === 'x.md');
        expect(entry?.lastAccessed).toBeDefined();
        expect(entry?.accessCount).toBe(1);
    });
});

describe('SynaipseService project enforcement', () => {
    it('getProject returns null when none configured', async () => {
        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();
        expect(service.getProject()).toBeNull();
    });

    it('getProject returns the configured name', async () => {
        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'app-x'));
        await service.start();
        expect(service.getProject()).toBe('app-x');
    });

    it('writeNote auto-prefixes a plain path to Memory/<project>/', async () => {
        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'app-x'));
        await service.start();

        const note = await service.writeNote({
            path: 'decisions/auth.md',
            content: 'body'
        });

        expect(note.id).toBe('Memory/app-x/decisions/auth.md');
    });

    it('writeNote rewrites a wrong project prefix', async () => {
        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'app-x'));
        await service.start();

        const note = await service.writeNote({
            path: 'Memory/other/decisions/auth.md',
            content: 'body'
        });

        expect(note.id).toBe('Memory/app-x/decisions/auth.md');
    });

    it('writeNote keeps an already-correct project path', async () => {
        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'app-x'));
        await service.start();

        const note = await service.writeNote({
            path: 'Memory/app-x/notes/foo.md',
            content: 'body'
        });

        expect(note.id).toBe('Memory/app-x/notes/foo.md');
    });

    it('writeNote injects project frontmatter and idempotent tag', async () => {
        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'app-x'));
        await service.start();

        const first = await service.writeNote({
            path: 'notes/foo.md',
            content: 'body',
            frontmatter: {title: 'Foo', tags: ['custom']}
        });

        expect(first.frontmatter.project).toBe('app-x');
        expect(first.frontmatter.tags).toEqual(expect.arrayContaining(['custom', 'project/app-x']));

        const second = await service.writeNote({
            path: 'notes/foo.md',
            content: 'body',
            frontmatter: {title: 'Foo', tags: ['custom', 'project/app-x']}
        });

        const tags = second.frontmatter.tags ?? [];
        expect(tags.filter((t) => t === 'project/app-x').length).toBe(1);
    });

    it('writeNote without a project throws ProjectScopeError', async () => {
        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        await expect(service.writeNote({path: 'foo.md', content: 'x'}))
            .rejects.toThrow(/project context/);
    });

    it('updateNote rejects a note outside project scope', async () => {
        await writeNote(vaultDir, 'Memory/other/foo.md', '---\ntitle: Foo\n---\nbody');

        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'app-x'));
        await service.start();

        await expect(service.updateNote('Memory/other/foo.md', {content: 'hack'}))
            .rejects.toThrow(/outside project scope/);
    });

    it('deleteNote rejects a note outside project scope', async () => {
        await writeNote(vaultDir, 'Memory/other/foo.md', '---\ntitle: Foo\n---\nbody');

        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'app-x'));
        await service.start();

        await expect(service.deleteNote('Memory/other/foo.md'))
            .rejects.toThrow(/outside project scope/);
    });

    it('linkNote rejects a source outside project scope', async () => {
        await writeNote(vaultDir, 'Memory/other/src.md', '---\ntitle: Source\n---\nbody');

        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'app-x'));
        await service.start();

        await expect(service.linkNote('Memory/other/src.md', ['Target']))
            .rejects.toThrow(/outside project scope/);
    });

    it('appendSessionLog writes into Memory/<project>/sessions/', async () => {
        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'app-x'));
        await service.start();

        const id = await service.appendSessionLog('worked on auth', []);
        expect(id.startsWith('Memory/app-x/sessions/')).toBe(true);
    });

    it('appendSessionLog without a project throws', async () => {
        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        await expect(service.appendSessionLog('x', []))
            .rejects.toThrow(/project context/);
    });

    it('appendInboxEntry writes into Memory/<project>/inbox/ with H3 entry and inline tags', async () => {
        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'app-x'));
        await service.start();

        const id = await service.appendInboxEntry('qdrant v2 drops legacy upsert', ['qdrant', 'breaking-change']);
        expect(id.startsWith('Memory/app-x/inbox/')).toBe(true);
        expect(id.endsWith('.md')).toBe(true);

        const note = service.readNote(id);
        expect(note.content).toMatch(/^### \d{2}:\d{2}\s*\n\s*\nqdrant v2 drops legacy upsert\s*\n\s*\n#qdrant #breaking-change\s*$/);
        expect(note.frontmatter.title).toMatch(/^Inbox \d{4}-\d{2}-\d{2}$/);
        expect(note.frontmatter.tags).toContain('inbox');
    });

    it('appendInboxEntry appends to existing file as separate H3 block', async () => {
        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'app-x'));
        await service.start();

        const id1 = await service.appendInboxEntry('first insight', []);
        const id2 = await service.appendInboxEntry('second insight', ['tagged']);
        expect(id1).toBe(id2);

        const note = service.readNote(id1);
        expect(note.content.match(/^### \d{2}:\d{2}$/gm)?.length).toBe(2);
        expect(note.content).toContain('first insight');
        expect(note.content).toContain('second insight');
        expect(note.content).toContain('#tagged');
    });

    it('appendInboxEntry strips leading # from tags and skips empty ones', async () => {
        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'app-x'));
        await service.start();

        const id = await service.appendInboxEntry('insight', ['#foo', '  ', 'bar', '']);
        const note = service.readNote(id);
        const tagLine = note.content.split('\n').find((l) => l.startsWith('#') && !l.startsWith('#'.repeat(2)));
        expect(tagLine).toBe('#foo #bar');
    });

    it('appendInboxEntry without a project throws', async () => {
        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        await expect(service.appendInboxEntry('x', []))
            .rejects.toThrow(/project context/);
    });

    it('appendInboxEntry with empty text throws', async () => {
        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'app-x'));
        await service.start();

        await expect(service.appendInboxEntry('   ', []))
            .rejects.toThrow(/text must not be empty/);
    });

    it('per-call project override beats the constructor default', async () => {
        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'default'));
        await service.start();

        const note = await service.writeNote(
            {path: 'foo.md', content: 'body'},
            {project: 'override'}
        );

        expect(note.id).toBe('Memory/override/foo.md');
        expect(note.frontmatter.project).toBe('override');
    });

    it('per-call override works without any constructor project', async () => {
        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const note = await service.writeNote(
            {path: 'foo.md', content: 'body'},
            {project: 'only-via-override'}
        );

        expect(note.id).toBe('Memory/only-via-override/foo.md');
    });

    it('getProject reflects the override', async () => {
        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'default'));
        await service.start();

        expect(service.getProject()).toBe('default');
        expect(service.getProject('override')).toBe('override');
    });

    it('writeNote injects per-call extraTags into frontmatter', async () => {
        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'app-x'));
        await service.start();

        const note = await service.writeNote(
            {path: 'foo.md', content: 'body', frontmatter: {tags: ['user']}},
            {extraTags: ['team/backend', 'kind/service']}
        );

        expect(note.frontmatter.tags).toEqual(expect.arrayContaining([
            'user', 'project/app-x', 'team/backend', 'kind/service'
        ]));
    });

    it('writeNote uses config extraTags when no per-call override is given', async () => {
        const cfg = {
            ...buildProjectConfig(vaultDir, cacheFile, 'app-x'),
            project: {name: 'app-x', extraTags: ['team/from-config']}
        };

        service = new SynaipseService(cfg);
        await service.start();

        const note = await service.writeNote({path: 'foo.md', content: 'body'});
        expect(note.frontmatter.tags).toEqual(expect.arrayContaining([
            'project/app-x', 'team/from-config'
        ]));
    });

    it('noteHistory returns [] for a note that was never tracked in ngit', async () => {
        const cfg = {
            ...buildProjectConfig(vaultDir, cacheFile, 'app-x'),
            git: {autoCommit: true, author: {name: 'T', email: 't@local'}}
        };

        service = new SynaipseService(cfg);
        await service.start();

        // seed one Synaipse-driven write so .ngit/ exists
        await service.writeNote({path: 'tracked.md', content: 'tracked'});

        // ask for the history of a different note that was never committed
        const history = await service.noteHistory('Memory/app-x/never-committed.md');
        expect(history).toEqual([]);
    });

    it('noteDiff returns empty string when path is missing in either side', async () => {
        const cfg = {
            ...buildProjectConfig(vaultDir, cacheFile, 'app-x'),
            git: {autoCommit: true, author: {name: 'T', email: 't@local'}}
        };

        service = new SynaipseService(cfg);
        await service.start();

        await service.writeNote({path: 'tracked.md', content: 'v1'});
        const headSha = (await service.getVault().getRepo())!;
        const sha = await headSha.head();

        const diff = await service.noteDiff('Memory/app-x/never-committed.md', sha!, sha!);
        expect(diff).toBe('');
    });

    it('verifyHistory returns ok for a healthy store', async () => {
        const cfg = {
            ...buildProjectConfig(vaultDir, cacheFile, 'app-x'),
            git: {autoCommit: true, author: {name: 'T', email: 't@local'}}
        };

        service = new SynaipseService(cfg);
        await service.start();
        await service.writeNote({path: 'a.md', content: 'body'});
        await service.writeNote({path: 'b.md', content: 'body2'});

        const report = await service.verifyHistory();
        expect(report).not.toBeNull();
        expect(report!.ok).toBe(true);
        expect(report!.checked).toBeGreaterThan(0);
    });

    it('verifyHistory returns null when no .ngit exists', async () => {
        service = new SynaipseService({
            ...buildProjectConfig(vaultDir, cacheFile, 'app-x'),
            git: {autoCommit: false, author: {name: 'T', email: 't@local'}}
        });
        await service.start();
        expect(await service.verifyHistory()).toBeNull();
    });

    it('snapshotList browses the vault at a past commit', async () => {
        const cfg = {
            ...buildProjectConfig(vaultDir, cacheFile, 'app-x'),
            git: {autoCommit: true, author: {name: 'T', email: 't@local'}}
        };

        service = new SynaipseService(cfg);
        await service.start();

        await service.writeNote({path: 'first.md', content: 'one'});
        const repo = await service.getVault().getRepo();
        const sha1 = await repo!.head();

        await service.writeNote({path: 'sub/second.md', content: 'two'});

        const root = await service.snapshotList(sha1!);
        expect(root.map((e) => e.name).sort()).toEqual(['Memory']);

        const memory = await service.snapshotList(sha1!, 'Memory/app-x');
        expect(memory.map((e) => e.name).sort()).toEqual(['first.md']);

        const headSha = (await repo!.head())!;
        const memoryHead = await service.snapshotList(headSha, 'Memory/app-x');
        expect(memoryHead.map((e) => e.name).sort()).toEqual(['first.md', 'sub']);
    });

    it('per-call gitAuthor flows into the autocommit', async () => {
        const cfg = {
            ...buildProjectConfig(vaultDir, cacheFile, 'app-x'),
            git: {
                autoCommit: true,
                author: {name: 'Default', email: 'default@local'}
            }
        };

        service = new SynaipseService(cfg);
        await service.start();

        await service.writeNote(
            {path: 'foo.md', content: 'body'},
            {gitAuthor: {name: 'Alice', email: 'alice@example.com'}}
        );

        const repo = await service.getVault().getRepo();
        expect(repo).not.toBeNull();

        const log = await repo!.log({});
        const head = log[0];
        expect(head?.author.name).toBe('Alice');
        expect(head?.author.email).toBe('alice@example.com');
    });

    it('updateNote with override targets a different project scope', async () => {
        await writeNote(vaultDir, 'Memory/override/foo.md', '---\ntitle: Foo\n---\nbody');

        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'default'));
        await service.start();

        await expect(service.updateNote('Memory/override/foo.md', {content: 'updated'}))
            .rejects.toThrow(/outside project scope/);

        const updated = await service.updateNote(
            'Memory/override/foo.md',
            {content: 'updated'},
            {project: 'override'}
        );

        expect(updated.content).toContain('updated');
    });
});

const buildChatConfig = (vaultPath: string, indexCachePath: string, model = 'gemma3:4b') => ({
    ...buildConfig(vaultPath, indexCachePath),
    chat: {provider: 'ollama' as const, url: 'http://fake-ollama', model}
});

const ollamaStreamResponse = (lines: string[]): Response => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const line of lines) {
                controller.enqueue(encoder.encode(line));
            }
            controller.close();
        }
    });
    return new Response(stream, {status: 200, headers: {'content-type': 'application/x-ndjson'}});
};

const collectChat = async (gen: AsyncGenerator<ChatEvent, void, void>): Promise<ChatEvent[]> => {
    const out: ChatEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
};

describe('SynaipseService.chat configuration', () => {
    it('chatEnabled returns false and getChatModel null when no chat config', async () => {
        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();
        expect(service.chatEnabled()).toBe(false);
        expect(service.getChatModel()).toBeNull();
    });

    it('chatEnabled and getChatModel reflect the configured model', async () => {
        service = new SynaipseService(buildChatConfig(vaultDir, cacheFile, 'qwen2.5:7b'));
        await service.start();
        expect(service.chatEnabled()).toBe(true);
        expect(service.getChatModel()).toBe('qwen2.5:7b');
    });

    it('chat() yields error event when not configured', async () => {
        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const events = await collectChat(service.chat({question: 'hi'}));
        expect(events.length).toBe(1);
        expect(events[0]?.kind).toBe('error');

        if (events[0]?.kind === 'error') {
            expect(events[0].message).toMatch(/not configured/);
        }
    });
});

describe('SynaipseService.chat end-to-end (mocked Ollama)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('searches the real vault, emits sources, streams tokens, then done', async () => {
        await writeNote(vaultDir, 'cluster.md', '---\ntitle: Cluster\n---\nBackendCluster decision body about scaling.');
        await writeNote(vaultDir, 'unrelated.md', '---\ntitle: Off-Topic\n---\nrecipes and cats');

        const fakeFetch = vi.fn(async () => ollamaStreamResponse([
            JSON.stringify({message: {role: 'assistant', content: 'Per '}}) + '\n',
            JSON.stringify({message: {role: 'assistant', content: 'context.'}}) + '\n',
            JSON.stringify({done: true, eval_count: 7}) + '\n'
        ])) as unknown as typeof fetch;

        vi.stubGlobal('fetch', fakeFetch);

        service = new SynaipseService(buildChatConfig(vaultDir, cacheFile));
        await service.start();

        const events = await collectChat(service.chat({question: 'cluster'}));

        const start = events.find((e) => e.kind === 'start');
        expect(start?.kind).toBe('start');
        if (start?.kind === 'start') {
            expect(start.model).toBe('gemma3:4b');
            // search should return the cluster note (matches keyword)
            expect(start.sources.length).toBeGreaterThan(0);
            expect(start.sources[0]?.title).toBe('Cluster');
            expect(start.sources[0]?.index).toBe(1);
        }

        const tokens = events.filter((e) => e.kind === 'token') as Extract<ChatEvent, {kind: 'token'}>[];
        expect(tokens.map((t) => t.text).join('')).toBe('Per context.');

        const done = events[events.length - 1];
        expect(done?.kind).toBe('done');
        if (done?.kind === 'done') {
            expect(done.totalTokens).toBe(7);
        }

        // verify the actual ollama request payload looks right
        expect(fakeFetch).toHaveBeenCalledOnce();
        const [calledUrl, calledInit] = fakeFetch.mock.calls[0] as [string, RequestInit];
        expect(calledUrl).toBe('http://fake-ollama/api/chat');
        const body = JSON.parse((calledInit.body as string));
        expect(body.model).toBe('gemma3:4b');
        expect(body.stream).toBe(true);
        expect(body.messages[0].role).toBe('system');
        expect(body.messages[1].role).toBe('user');
        expect(body.messages[1].content).toContain('cluster');
        expect(body.messages[1].content).toContain('Cluster');
    });

    it('respects pathPrefix when scoping the RAG context', async () => {
        await writeNote(vaultDir, 'scoped/in.md', '---\ntitle: Inside\n---\ncluster body');
        await writeNote(vaultDir, 'outside.md', '---\ntitle: Outside\n---\ncluster body');

        const fakeFetch = vi.fn(async () => ollamaStreamResponse([
            JSON.stringify({done: true, eval_count: 0}) + '\n'
        ])) as unknown as typeof fetch;
        vi.stubGlobal('fetch', fakeFetch);

        service = new SynaipseService(buildChatConfig(vaultDir, cacheFile));
        await service.start();

        const events = await collectChat(service.chat({question: 'cluster', pathPrefix: 'scoped/'}));

        const start = events.find((e) => e.kind === 'start');
        if (start?.kind === 'start') {
            expect(start.sources.map((s) => s.noteId)).toEqual(['scoped/in.md']);
        }
    });

    it('strips frontmatter from the synthesized snippet when search has no snippet', async () => {
        await writeNote(vaultDir, 'fm.md', '---\ntitle: FM\ntags: [a, b]\n---\nclean body content cluster.');

        const fakeFetch = vi.fn(async () => ollamaStreamResponse([
            JSON.stringify({done: true}) + '\n'
        ])) as unknown as typeof fetch;
        vi.stubGlobal('fetch', fakeFetch);

        service = new SynaipseService(buildChatConfig(vaultDir, cacheFile));
        await service.start();

        const events = await collectChat(service.chat({question: 'cluster'}));
        const start = events.find((e) => e.kind === 'start');

        if (start?.kind === 'start') {
            const snippet = start.sources[0]?.snippet ?? '';
            expect(snippet).toContain('clean body');
            expect(snippet).not.toContain('tags:');
            expect(snippet).not.toContain('---');
        }
    });

    it('propagates an Ollama 500 into an error event', async () => {
        await writeNote(vaultDir, 'note.md', '---\ntitle: N\n---\ncluster');

        const fakeFetch = vi.fn(async () => new Response('boom', {status: 500})) as unknown as typeof fetch;
        vi.stubGlobal('fetch', fakeFetch);

        service = new SynaipseService(buildChatConfig(vaultDir, cacheFile));
        await service.start();

        const events = await collectChat(service.chat({question: 'cluster'}));
        const last = events[events.length - 1];
        expect(last?.kind).toBe('error');
        if (last?.kind === 'error') {
            expect(last.message).toMatch(/500|Ollama/);
        }
    });
});

describe('SynaipseService DSGVO Layer 2 (per-note sensitivity)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('summarize blocks a private note when the chat provider is external', async () => {
        await writeNote(vaultDir, 'Private/diary.md', '---\ntitle: Diary\n---\nSensitive thoughts.');

        const fakeFetch = vi.fn(async () => ollamaStreamResponse([])) as unknown as typeof fetch;
        vi.stubGlobal('fetch', fakeFetch);

        // http://fake-ollama is treated as external by isLocalUrl (no loopback/RFC1918/.local).
        service = new SynaipseService({
            ...buildConfig(vaultDir, cacheFile),
            chat: {provider: 'ollama' as const, url: 'http://fake-ollama', model: 'm'}
        });
        await service.start();

        const events: ChatEvent[] = [];
        for await (const e of service.summarizeNote('Private/diary.md') as AsyncGenerator<ChatEvent, void, void>) {
            events.push(e);
        }

        expect(events.length).toBe(1);
        const ev = events[0];
        expect(ev?.kind).toBe('error');
        if (ev?.kind === 'error') expect(ev.message).toMatch(/privat/i);
        expect(fakeFetch).not.toHaveBeenCalled();
    });

    it('summarize allows a private note when the chat provider is local (loopback URL)', async () => {
        await writeNote(vaultDir, 'Private/diary.md', '---\ntitle: Diary\n---\nSensitive thoughts about clusters.');

        const fakeFetch = vi.fn(async () => ollamaStreamResponse([
            JSON.stringify({message: {role: 'assistant', content: 'short summary'}}) + '\n',
            JSON.stringify({done: true}) + '\n'
        ])) as unknown as typeof fetch;
        vi.stubGlobal('fetch', fakeFetch);

        service = new SynaipseService({
            ...buildConfig(vaultDir, cacheFile),
            chat: {provider: 'ollama' as const, url: 'http://127.0.0.1:11434', model: 'm'}
        });
        await service.start();

        const events: ChatEvent[] = [];
        for await (const e of service.summarizeNote('Private/diary.md') as AsyncGenerator<ChatEvent, void, void>) {
            events.push(e);
        }

        const last = events[events.length - 1];
        expect(last?.kind).toBe('done');
        expect(fakeFetch).toHaveBeenCalledOnce();
    });

    it('chat hides private notes from sources when the chat provider is external', async () => {
        await writeNote(vaultDir, 'public.md', '---\ntitle: Public\n---\ncluster body content');
        await writeNote(vaultDir, 'Private/secrets.md', '---\ntitle: Secret\n---\ncluster sensitive details');

        const fakeFetch = vi.fn(async () => ollamaStreamResponse([
            JSON.stringify({done: true}) + '\n'
        ])) as unknown as typeof fetch;
        vi.stubGlobal('fetch', fakeFetch);

        service = new SynaipseService({
            ...buildConfig(vaultDir, cacheFile),
            chat: {provider: 'ollama' as const, url: 'http://fake-ollama', model: 'm'}
        });
        await service.start();

        const events = await collectChat(service.chat({question: 'cluster'}));
        const start = events.find((e) => e.kind === 'start');

        if (start?.kind === 'start') {
            const ids = start.sources.map((s) => s.noteId);
            expect(ids).toContain('public.md');
            expect(ids).not.toContain('Private/secrets.md');
        } else {
            throw new Error('expected start event');
        }
    });
});

describe('SynaipseService.prime', () => {
    it('includes pinned, recent session, decision, hot and recent notes with reasons', async () => {
        await writeNote(vaultDir, 'Memory/foo/sessions/2026-06-18.md', '---\ntitle: Session 2026-06-18\n---\nWorked on prime tool.');
        await writeNote(vaultDir, 'Memory/foo/decisions/dolt-vs-md.md', '---\ntitle: Dolt vs Markdown\n---\nWe stay on Markdown.');
        await writeNote(vaultDir, 'Memory/foo/hot.md', '---\ntitle: Hot\n---\nCentral node.');
        await writeNote(vaultDir, 'Memory/foo/a.md', '---\ntitle: A\n---\nLinks to [[Hot]].');
        await writeNote(vaultDir, 'Memory/foo/b.md', '---\ntitle: B\n---\nLinks to [[Hot]].');
        await writeNote(vaultDir, 'Memory/foo/c.md', '---\ntitle: C\n---\nLinks to [[Hot]].');
        await writeNote(vaultDir, 'Memory/foo/pinned.md', '---\ntitle: Pinned\npinned: true\n---\nAlways read me.');
        await writeNote(vaultDir, 'Memory/foo/recent.md', '---\ntitle: Recent\n---\nFresh edit.');
        await writeNote(vaultDir, 'Memory/other/leak.md', '---\ntitle: Leak\n---\nShould not appear in foo prime.');

        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'foo'));
        await service.start();

        const result = await service.prime({limit: 10});

        const byReason = new Map<string, string[]>();
        for (const entry of result.context) {
            const list = byReason.get(entry.reason) ?? [];
            list.push(entry.id);
            byReason.set(entry.reason, list);
        }

        expect(result.project).toBe('foo');
        expect(byReason.get('pinned')).toEqual(['Memory/foo/pinned.md']);
        expect(byReason.get('recent_session')).toEqual(['Memory/foo/sessions/2026-06-18.md']);
        expect(byReason.get('project_decision')).toEqual(['Memory/foo/decisions/dolt-vs-md.md']);
        expect(byReason.get('hot')?.[0]).toBe('Memory/foo/hot.md');
        expect(result.context.map((e) => e.id)).not.toContain('Memory/other/leak.md');

        const hot = result.context.find((e) => e.reason === 'hot' && e.id === 'Memory/foo/hot.md');
        expect(hot?.backlinkCount).toBe(3);
        expect(hot?.excerpt.length).toBeGreaterThan(0);
    });

    it('includes a todo digest scoped to the project', async () => {
        await writeNote(vaultDir, 'Memory/foo/work.md', '- [ ] first\n- [ ] second\n- [x] done');
        await writeNote(vaultDir, 'Memory/bar/work.md', '- [ ] other-project');

        service = new SynaipseService(buildProjectConfig(vaultDir, cacheFile, 'foo'));
        await service.start();

        const result = await service.prime();
        expect(result.todoCount).toBe(2);
        expect(result.todoSample.map((t) => t.text)).toEqual(['first', 'second']);
    });

    it('returns global view when no project is set', async () => {
        await writeNote(vaultDir, 'Memory/sessions/2026-06-18.md', '---\ntitle: Global session\n---\nNo project.');
        await writeNote(vaultDir, 'Memory/decisions/global.md', '---\ntitle: Global decision\n---\nglobal.');
        await writeNote(vaultDir, 'Memory/foo/decisions/scoped.md', '---\ntitle: Scoped decision\n---\nproject-only.');

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const result = await service.prime({limit: 10});
        expect(result.project).toBeNull();
        const decisions = result.context.filter((e) => e.reason === 'project_decision').map((e) => e.id);
        expect(decisions).toEqual(['Memory/decisions/global.md']);
        const sessions = result.context.filter((e) => e.reason === 'recent_session').map((e) => e.id);
        expect(sessions).toEqual(['Memory/sessions/2026-06-18.md']);
    });

    it('excludes Crawler/ from hot, recent and todos by default but keeps it with includeCrawler', async () => {
        await writeNote(vaultDir, 'Crawler/github/_index.md', '- [ ] crawler todo\n- [ ] another');
        await writeNote(vaultDir, 'Crawler/github/repo-a.md', '---\ntitle: Repo A\n---\nLinks to [[_index]].');
        await writeNote(vaultDir, 'Crawler/github/repo-b.md', '---\ntitle: Repo B\n---\nLinks to [[_index]].');
        await writeNote(vaultDir, 'Crawler/github/repo-c.md', '---\ntitle: Repo C\n---\nLinks to [[_index]].');
        await writeNote(vaultDir, 'Memory/note.md', '---\ntitle: Note\n---\n- [ ] real todo');

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const def = await service.prime({limit: 10});
        expect(def.context.map((e) => e.id).every((id) => !id.startsWith('Crawler/'))).toBe(true);
        expect(def.todoCount).toBe(1);
        expect(def.todoSample[0]?.text).toBe('real todo');

        const opted = await service.prime({limit: 10, includeCrawler: true});
        expect(opted.context.some((e) => e.id.startsWith('Crawler/'))).toBe(true);
        expect(opted.todoCount).toBe(3);
    });

    it('places topic results above hot and recent when topic is given', async () => {
        await writeNote(vaultDir, 'Memory/hot.md', '---\ntitle: Hot\n---\nUnrelated central node.');
        await writeNote(vaultDir, 'Memory/a.md', '---\ntitle: A\n---\nLinks to [[Hot]].');
        await writeNote(vaultDir, 'Memory/b.md', '---\ntitle: B\n---\nLinks to [[Hot]].');
        await writeNote(vaultDir, 'Memory/c.md', '---\ntitle: C\n---\nLinks to [[Hot]].');
        await writeNote(vaultDir, 'Memory/qdrant.md', '---\ntitle: Qdrant Setup\n---\nDocker compose for qdrant vector store.');

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const result = await service.prime({limit: 10, topic: 'qdrant'});
        const reasons = result.context.map((e) => e.reason);
        const topicIdx = reasons.indexOf('topic');
        const hotIdx = reasons.indexOf('hot');

        expect(topicIdx).toBeGreaterThanOrEqual(0);
        expect(hotIdx).toBeGreaterThanOrEqual(0);
        expect(topicIdx).toBeLessThan(hotIdx);
        expect(result.context.find((e) => e.reason === 'topic')?.id).toBe('Memory/qdrant.md');
    });

    it('topic search includes Crawler/ hits even when includeCrawler is false', async () => {
        await writeNote(vaultDir, 'Memory/unrelated.md', '---\ntitle: Unrelated\n---\nNothing to see.');
        await writeNote(vaultDir, 'Crawler/code/synaipse/qdrant-client.md', '---\ntitle: Qdrant client\n---\nThe qdrant vector store client implementation.');

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const result = await service.prime({limit: 10, topic: 'qdrant'});
        const topicHits = result.context.filter((e) => e.reason === 'topic').map((e) => e.id);
        expect(topicHits).toContain('Crawler/code/synaipse/qdrant-client.md');

        const hotHits = result.context.filter((e) => e.reason === 'hot').map((e) => e.id);
        expect(hotHits.every((id) => !id.startsWith('Crawler/'))).toBe(true);
    });
});

describe('SynaipseService graph signal in hybrid search', () => {
    it('boosts hits that are wikilink-neighbours of a pinned seed', async () => {
        // Both 'near' and 'far' match the query "alpha" equally via fulltext.
        // 'near' is wikilinked from the pinned seed → graph signal should
        // promote it above 'far'. Title hits don't fire because 'alpha' is
        // body-only, so fulltext and graph are the active fusion signals.
        await writeNote(
            vaultDir,
            'Pinned.md',
            '---\ntitle: Pinned Hub\npinned: true\n---\nrefers to [[Near]]'
        );
        await writeNote(
            vaultDir,
            'Near.md',
            '---\ntitle: Near\n---\nshared keyword alpha sits here'
        );
        await writeNote(
            vaultDir,
            'Far.md',
            '---\ntitle: Far\n---\nshared keyword alpha sits here'
        );

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const hits = await service.search('alpha', 'hybrid', 10);
        const ids = hits.map((h) => h.noteId);

        expect(ids).toContain('Near.md');
        expect(ids).toContain('Far.md');
        expect(ids.indexOf('Near.md')).toBeLessThan(ids.indexOf('Far.md'));

        const near = hits.find((h) => h.noteId === 'Near.md');
        const far = hits.find((h) => h.noteId === 'Far.md');
        expect(near?.components?.graph).toBeDefined();
        expect(far?.components?.graph).toBeUndefined();
    });

    it('omits the graph signal entirely when no seeds exist', async () => {
        await writeNote(vaultDir, 'A.md', '---\ntitle: A\n---\nalpha keyword');
        await writeNote(vaultDir, 'B.md', '---\ntitle: B\n---\nalpha keyword');

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        const hits = await service.search('alpha', 'hybrid', 10);
        for (const hit of hits) {
            expect(hit.components?.graph).toBeUndefined();
        }
    });

    it('treats recently-accessed notes as seeds too', async () => {
        // Hub is unpinned but gets touched via readNote, which writes
        // lastAccessed into the cache. That alone should be enough to make
        // Hub act as a graph seed and promote its neighbour Near.
        await writeNote(
            vaultDir,
            'Hub.md',
            '---\ntitle: Hub\n---\nrefers to [[Near]]'
        );
        await writeNote(
            vaultDir,
            'Near.md',
            '---\ntitle: Near\n---\nshared keyword alpha sits here'
        );
        await writeNote(
            vaultDir,
            'Far.md',
            '---\ntitle: Far\n---\nshared keyword alpha sits here'
        );

        service = new SynaipseService(buildConfig(vaultDir, cacheFile));
        await service.start();

        service.readNote('Hub.md');

        const hits = await service.search('alpha', 'hybrid', 10);
        const near = hits.find((h) => h.noteId === 'Near.md');
        const far = hits.find((h) => h.noteId === 'Far.md');
        expect(near?.components?.graph).toBeDefined();
        expect(far?.components?.graph).toBeUndefined();
        expect(hits.indexOf(near as SearchHit)).toBeLessThan(hits.indexOf(far as SearchHit));
    });
});