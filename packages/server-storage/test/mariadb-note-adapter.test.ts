import {describe, it, expect, beforeAll, afterAll, beforeEach} from 'vitest';
import type {Pool} from 'mariadb';
import {MariaDBNoteAdapter} from '../src/MariaDBNoteAdapter.js';
import type {ResolvedMariaDBConfig} from '../src/Pool.js';
import {connectAndMigrate, integrationEnabled} from './helpers.js';

describe.skipIf(!integrationEnabled)('MariaDBNoteAdapter (integration)', () => {
    let pool: Pool;
    let cfg: ResolvedMariaDBConfig;

    beforeAll(async () => {
        ({pool, cfg} = await connectAndMigrate());
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query('TRUNCATE TABLE notes');
    });

    it('load() warms an empty snapshot when the table is empty', async () => {
        const adapter = new MariaDBNoteAdapter(pool, cfg);
        await adapter.load();
        expect(adapter.isLoaded()).toBe(true);
        expect(adapter.list()).toEqual([]);
        expect(adapter.entryIds()).toEqual([]);
    });

    it('write() persists a note and indexes tags + wikilinks', async () => {
        const adapter = new MariaDBNoteAdapter(pool, cfg);
        await adapter.load();

        const note = await adapter.write({
            path: 'Notes/Alpha.md',
            content: '# Alpha\n\nLinks to [[Beta]] with #demo tag.',
            frontmatter: {title: 'Alpha', tags: ['intro']}
        });

        expect(note.id).toBe('Notes/Alpha.md');
        expect(note.hash).toMatch(/^[a-f0-9]{40}$/);
        expect(note.tags.sort()).toEqual(['demo', 'intro']);
        expect(note.wikilinks).toEqual(['Beta']);

        expect(adapter.list().map((n) => n.id)).toEqual(['Notes/Alpha.md']);
        expect(adapter.tags().get('demo')).toEqual(['Notes/Alpha.md']);
        // Backlinks are keyed by note id (path), not by the raw link text —
        // `[[Beta]]` only produces a backlink once a note titled Beta exists.
        expect(adapter.backlinksOf('Beta')).toEqual([]);
        await adapter.write({path: 'Notes/Beta.md', content: '# Beta', frontmatter: {title: 'Beta'}});
        expect(adapter.backlinksOf('Notes/Beta.md')).toEqual(['Notes/Alpha.md']);
        expect(adapter.get('Notes/Beta.md').backlinks).toEqual(['Notes/Alpha.md']);
    });

    it('backlinks resolve via aliases and survive a reload', async () => {
        const a = new MariaDBNoteAdapter(pool, cfg);
        await a.load();
        await a.write({path: 'Notes/Target.md', content: 'body', frontmatter: {title: 'Target', aliases: ['tgt']}});
        await a.write({path: 'Notes/Src1.md', content: 'see [[Target]]', frontmatter: {title: 'Src1'}});
        await a.write({path: 'Notes/Src2.md', content: 'see [[tgt]]', frontmatter: {title: 'Src2'}});
        expect(a.backlinksOf('Notes/Target.md').sort()).toEqual(['Notes/Src1.md', 'Notes/Src2.md']);

        const b = new MariaDBNoteAdapter(pool, cfg);
        await b.load();
        expect(b.backlinksOf('Notes/Target.md').sort()).toEqual(['Notes/Src1.md', 'Notes/Src2.md']);
    });

    it('B2: embedded state is tracked separately from the content hash and persists', async () => {
        const a = new MariaDBNoteAdapter(pool, cfg);
        await a.load();
        const v1 = await a.write({path: 'Notes/E.md', content: 'v1', frontmatter: {title: 'E'}});

        // Fresh write: not embedded yet → the service must embed it.
        expect(a.getEntry(v1.id)?.embeddedHash).toBeUndefined();

        a.recordEmbedded(v1.id, v1.hash, 'voyage:m:3');
        await a.flushEntries();

        // Content moves on; embedded marker stays at v1 until re-embedded.
        const v2 = await a.write({path: 'Notes/E.md', content: 'v2', frontmatter: {title: 'E'}});
        expect(a.getEntry(v2.id)).toMatchObject({hash: v2.hash, embeddedHash: v1.hash, embedModel: 'voyage:m:3'});

        const b = new MariaDBNoteAdapter(pool, cfg);
        await b.load();
        expect(b.getEntry('Notes/E.md')).toMatchObject({hash: v2.hash, embeddedHash: v1.hash, embedModel: 'voyage:m:3'});
    });

    it('upsert keeps a single row + refreshes the hash on rewrite', async () => {
        const adapter = new MariaDBNoteAdapter(pool, cfg);
        await adapter.load();

        const first = await adapter.write({
            path: 'Notes/Beta.md',
            content: '# Beta v1',
            frontmatter: {title: 'Beta'}
        });
        const second = await adapter.write({
            path: 'Notes/Beta.md',
            content: '# Beta v2 with new body',
            frontmatter: {title: 'Beta'}
        });

        expect(second.hash).not.toBe(first.hash);
        expect(adapter.list()).toHaveLength(1);

        const [{n}] = await pool.query<{n: number}[]>(
            'SELECT COUNT(*) AS n FROM notes WHERE note_path = ?',
            ['Notes/Beta.md']
        );
        expect(n).toBe(1);
    });

    it('access journal persists across adapter instances', async () => {
        const a = new MariaDBNoteAdapter(pool, cfg);
        await a.load();
        await a.write({
            path: 'Notes/Gamma.md',
            content: '# Gamma',
            frontmatter: {title: 'Gamma'}
        });

        a.recordAccess('Notes/Gamma.md');
        a.recordAccess('Notes/Gamma.md');
        a.recordAccess('Notes/Gamma.md');
        await a.flushEntries();

        const fresh = new MariaDBNoteAdapter(pool, cfg);
        await fresh.load();
        expect(fresh.getEntry('Notes/Gamma.md')?.accessCount).toBe(3);
    });

    it('reference journal (referencedCount/lastReferenced) persists across adapter instances, independent of accessCount', async () => {
        const a = new MariaDBNoteAdapter(pool, cfg);
        await a.load();
        await a.write({
            path: 'Notes/Zeta.md',
            content: '# Zeta',
            frontmatter: {title: 'Zeta'}
        });

        a.recordAccess('Notes/Zeta.md');
        a.recordReference('Notes/Zeta.md');
        a.recordReference('Notes/Zeta.md');
        await a.flushEntries();

        const fresh = new MariaDBNoteAdapter(pool, cfg);
        await fresh.load();
        const entry = fresh.getEntry('Notes/Zeta.md');
        expect(entry?.accessCount).toBe(1);
        expect(entry?.referencedCount).toBe(2);
        expect(entry?.lastReferenced).toBeDefined();
    });

    it('delete() removes the row + clears in-memory indexes', async () => {
        const adapter = new MariaDBNoteAdapter(pool, cfg);
        await adapter.load();
        await adapter.write({
            path: 'Notes/Delta.md',
            content: '# Delta with [[Epsilon]] #tagged',
            frontmatter: {title: 'Delta'}
        });

        await adapter.delete('Notes/Delta.md');

        expect(adapter.tryGet('Notes/Delta.md')).toBeUndefined();
        expect(adapter.tags().get('tagged')).toBeUndefined();
        expect(adapter.backlinksOf('Epsilon')).toEqual([]);

        const [{n}] = await pool.query<{n: number}[]>('SELECT COUNT(*) AS n FROM notes');
        expect(n).toBe(0);
    });

    it('syncEntries() is a no-op because the DB is the SoT', async () => {
        const adapter = new MariaDBNoteAdapter(pool, cfg);
        await adapter.load();
        await expect(adapter.syncEntries()).resolves.toBe(false);
    });
});