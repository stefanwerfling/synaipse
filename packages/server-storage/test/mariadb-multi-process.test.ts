import {describe, it, expect, beforeAll, afterAll, beforeEach} from 'vitest';
import type {Pool} from 'mariadb';
import type {ExternalNoteChange} from '@synaipse/core';
import {MariaDBNoteAdapter} from '../src/MariaDBNoteAdapter.js';
import type {ResolvedMariaDBConfig} from '../src/Pool.js';
import {connectAndMigrate, integrationEnabled, resetVault} from './helpers.js';

/** Two adapters on one database stand in for two Synaipse processes (plan A6). */
describe.skipIf(!integrationEnabled)('MariaDBNoteAdapter across processes (integration)', () => {
    let pool: Pool;
    let cfg: ResolvedMariaDBConfig;

    beforeAll(async () => {
        ({pool, cfg} = await connectAndMigrate());
        // Own vault namespace: the note-adapter tests run in parallel on vault 1.
        cfg = {...cfg, vaultId: 2};
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await resetVault(pool, cfg.vaultId);
    });

    const pair = async () => {
        const opts = {...cfg, accessFlushMs: 0, changePollMs: 0};
        const a = new MariaDBNoteAdapter(pool, opts);
        const b = new MariaDBNoteAdapter(pool, opts);
        await a.load();
        await b.load();
        const seen: ExternalNoteChange[][] = [];
        b.onExternalChange((changes) => seen.push([...changes]));
        return {a, b, seen};
    };

    it('applies writes and deletes of another process, with backlinks and tags', async () => {
        const {a, b, seen} = await pair();
        await a.write({path: 'N/target.md', content: '# Target', frontmatter: {title: 'Target'}});
        await a.write({path: 'N/src.md', content: 'see [[Target]] #shared'});

        await b.pollChanges();
        expect(b.list().map((n) => n.id).sort()).toEqual(['N/src.md', 'N/target.md']);
        expect(b.backlinksOf('N/target.md')).toEqual(['N/src.md']);
        expect(b.tags().get('shared')).toEqual(['N/src.md']);
        expect(seen.flat().map((c) => c.kind)).toEqual(['changed', 'changed']);

        await a.write({path: 'N/src.md', content: 'no links now'});
        await a.delete('N/target.md');
        await b.pollChanges();
        expect(b.list().map((n) => n.id)).toEqual(['N/src.md']);
        expect(b.get('N/src.md').content).toBe('no links now');
        expect(seen[1]?.map((c) => c.kind).sort()).toEqual(['changed', 'removed']);
    });

    it('does not report its own writes back, and nothing when nothing changed', async () => {
        const {b, seen} = await pair();
        await b.write({path: 'N/own.md', content: 'mine'});
        await b.delete('N/own.md');
        await b.write({path: 'N/own2.md', content: 'mine too'});
        await b.pollChanges();
        await b.pollChanges();
        expect(seen).toEqual([]);
    });

    it('reports a later foreign write to a note it wrote itself', async () => {
        const {a, b, seen} = await pair();
        await b.write({path: 'N/both.md', content: 'from b'});
        await a.pollChanges();
        await a.write({path: 'N/both.md', content: 'from a'});
        await b.pollChanges();
        expect(b.get('N/both.md').content).toBe('from a');
        expect(seen.flat()).toHaveLength(1);
    });

    it('reloads fully when the change log has a gap', async () => {
        const {a, b, seen} = await pair();
        await a.write({path: 'N/x.md', content: 'x'});
        await a.write({path: 'N/y.md', content: 'y'});
        await pool.query('DELETE FROM note_changes WHERE vault_id = ? AND version = 1', [cfg.vaultId]);

        await b.pollChanges();
        expect(seen).toEqual([[{kind: 'reset'}]]);
        expect(b.list().map((n) => n.id).sort()).toEqual(['N/x.md', 'N/y.md']);
    });

    it('versions writes from concurrent processes without duplicates or holes', async () => {
        const {a, b} = await pair();
        await Promise.all(Array.from({length: 20}, (_, i) => (i % 2 === 0 ? a : b).write({path: `C/n${i}.md`, content: `n${i}`})));
        const rows = await pool.query<{version: number}[]>('SELECT version FROM note_changes WHERE vault_id = ? ORDER BY version', [cfg.vaultId]);
        expect(rows.map((r) => r.version)).toEqual(Array.from({length: 20}, (_, i) => i + 1));

        await a.pollChanges();
        await b.pollChanges();
        expect(a.list()).toHaveLength(20);
        expect(b.list()).toHaveLength(20);
    });

    it('polls on its own timer', async () => {
        const a = new MariaDBNoteAdapter(pool, {...cfg, accessFlushMs: 0, changePollMs: 0});
        const b = new MariaDBNoteAdapter(pool, {...cfg, accessFlushMs: 0, changePollMs: 40});
        await a.load();
        await b.load();
        await a.write({path: 'N/t.md', content: 't'});
        await new Promise((r) => setTimeout(r, 200));
        expect(b.tryGet('N/t.md')?.content).toBe('t');
        b.closeLocal();
    });
});
