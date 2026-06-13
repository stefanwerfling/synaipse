import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, writeFile, mkdir, readFile, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SynaipseService} from '../src/Service.js';

const buildConfig = (vaultPath: string, indexCachePath: string) => ({
    vaultPath,
    indexCachePath,
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
});