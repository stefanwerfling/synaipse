// One-off smoke test for MariaDBNoteAdapter. Run against the docker-compose
// `server` profile (mariadb:11.7 on port 3307 by default).
//
//   docker compose --profile server up -d mariadb
//   npm run build
//   node packages/server-storage/scripts/smoke.mjs
//
// Exits non-zero on any failed assertion.

import {strict as assert} from 'node:assert';
import {MariaDBNoteAdapter, createPool, resolveConfig} from '../dist/Index.js';

const cfg = resolveConfig({
    host: process.env.SYNAIPSE_MARIADB_HOST ?? '127.0.0.1',
    port: Number(process.env.SYNAIPSE_MARIADB_PORT ?? '3307'),
    user: process.env.SYNAIPSE_MARIADB_USER ?? 'synaipse',
    password: process.env.SYNAIPSE_MARIADB_PASSWORD ?? 'synaipse',
    database: process.env.SYNAIPSE_MARIADB_DATABASE ?? 'synaipse'
});

const pool = createPool(cfg);
const adapter = new MariaDBNoteAdapter(pool, cfg);

const step = (label) => console.error(`  · ${label}`);
let ok = true;

try {
    step('TRUNCATE notes (clean slate)');
    await pool.query('TRUNCATE TABLE notes');

    step('load() empty');
    await adapter.load();
    assert.equal(adapter.isLoaded(), true);
    assert.equal(adapter.list().length, 0);

    step('write() a note');
    const written = await adapter.write({
        path: 'Notes/Hello.md',
        content: '# Hello\n\nWorld with #greeting tag and a [[Other]] wikilink.',
        frontmatter: {title: 'Hello', tags: ['demo']}
    });
    assert.equal(written.id, 'Notes/Hello.md');
    assert.equal(written.title, 'Hello');
    assert.ok(written.hash.length === 40);
    assert.ok(written.tags.includes('demo'));
    assert.ok(written.tags.includes('greeting'));
    assert.deepEqual(written.wikilinks, ['Other']);

    step('list() reflects write');
    assert.equal(adapter.list().length, 1);

    step('get() returns it');
    const got = adapter.get('Notes/Hello.md');
    assert.equal(got.title, 'Hello');

    step('tags() index');
    const tags = adapter.tags();
    assert.deepEqual(tags.get('demo'), ['Notes/Hello.md']);
    assert.deepEqual(tags.get('greeting'), ['Notes/Hello.md']);

    step('backlinksOf(Other) shows Hello as a backlink');
    assert.deepEqual(adapter.backlinksOf('Other'), ['Notes/Hello.md']);

    step('recordAccess() + flushEntries() persist counters');
    adapter.recordAccess('Notes/Hello.md');
    adapter.recordAccess('Notes/Hello.md');
    await adapter.flushEntries();
    const [{access_count, last_accessed}] = await pool.query(
        'SELECT access_count, last_accessed FROM notes WHERE note_path = ?',
        ['Notes/Hello.md']
    );
    assert.equal(access_count, 2);
    assert.ok(last_accessed > 0);

    step('reload from DB carries access journal');
    const fresh = new MariaDBNoteAdapter(pool, cfg);
    await fresh.load();
    const entry = fresh.getEntry('Notes/Hello.md');
    assert.equal(entry?.accessCount, 2);

    step('write() upsert replaces body, refreshes hash');
    const updated = await adapter.write({
        path: 'Notes/Hello.md',
        content: '# Hello\n\nUpdated body, no tags now.',
        frontmatter: {title: 'Hello'}
    });
    assert.notEqual(updated.hash, written.hash);
    assert.equal(adapter.list().length, 1, 'still exactly one row');

    step('delete() removes from DB and memory');
    await adapter.delete('Notes/Hello.md');
    assert.equal(adapter.list().length, 0);
    assert.equal(adapter.tryGet('Notes/Hello.md'), undefined);
    const rows = await pool.query('SELECT COUNT(*) AS n FROM notes');
    assert.equal(rows[0].n, 0);

    console.error('\n✓ MariaDBNoteAdapter smoke test passed');
} catch (err) {
    ok = false;
    console.error('\n✗ FAILED:', err);
} finally {
    await pool.end();
    process.exit(ok ? 0 : 1);
}