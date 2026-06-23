// End-to-end smoke for the SYNAIPSE_MODE=server boot path.
// Builds a SynaipseService against the docker-compose mariadb (port 3307
// by default) using the same factory the web server uses in prod boot,
// then drives a few Service methods to confirm the DB-backed adapters
// route through correctly. No vault directory is required: NoopHistory
// + skipWatcher keep the filesystem layer dormant.
//
//   docker compose --profile server up -d mariadb
//   npm run build
//   node packages/server-storage/scripts/server-mode-smoke.mjs

import {strict as assert} from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync, rmSync} from 'node:fs';
import {SynaipseService} from '../../service/dist/Index.js';
import {NoopHistory} from '../../vault/dist/Index.js';
import {createServerAdapters} from '../dist/Index.js';

const dummyVault = mkdtempSync(path.join(os.tmpdir(), 'synaipse-server-mode-'));

const config = {
    vaultPath: dummyVault,
    indexCachePath: path.join(dummyVault, '.synaipse-index.json'),
    chatStoreDir: path.join(dummyVault, '.synaipse-chats'),
    embeddings: {provider: 'none'},
    qdrant: {url: 'http://localhost:6333', collection: 'synaipse'},
    server: {name: 'synaipse', version: '0.1.0'},
    web: {port: 5757},
    git: {autoCommit: false, author: {name: 'Synaipse', email: 'synaipse@local'}},
    chat: {provider: 'ollama', model: 'gemma3:4b', url: 'http://localhost:11434'},
    project: {name: 'smoke'},
    mode: 'server',
    mariadb: {
        host: process.env.SYNAIPSE_MARIADB_HOST ?? '127.0.0.1',
        port: Number(process.env.SYNAIPSE_MARIADB_PORT ?? '3307'),
        user: process.env.SYNAIPSE_MARIADB_USER ?? 'synaipse',
        password: process.env.SYNAIPSE_MARIADB_PASSWORD ?? 'synaipse',
        database: process.env.SYNAIPSE_MARIADB_DATABASE ?? 'synaipse'
    }
};

const step = (label) => console.error(`  · ${label}`);
let ok = true;
let bundle;
let service;

try {
    step('createServerAdapters() — applies migrations, builds bundle');
    bundle = await createServerAdapters(config.mariadb);

    step('TRUNCATE tables for clean slate');
    await bundle.pool.query('TRUNCATE TABLE notes');
    await bundle.pool.query('TRUNCATE TABLE chat_sessions');

    step('Construct SynaipseService with server-mode overrides');
    service = new SynaipseService(config, {
        notes: bundle.notes,
        chats: bundle.chats,
        history: new NoopHistory(),
        skipWatcher: true
    });

    step('service.start() — loads adapters, builds fulltext index');
    await service.start();

    step('Empty notes list at boot');
    assert.equal(service.listNotes().length, 0);

    step('writeNote() persists through MariaDBNoteAdapter');
    const written = await service.writeNote({
        path: 'Memory/smoke/Notes/ServerHello.md',
        content: '# ServerHello\n\nWritten via server-mode boot path. #server-mode',
        frontmatter: {title: 'ServerHello'}
    });
    assert.equal(written.id, 'Memory/smoke/Notes/ServerHello.md');

    step('Note round-trips through Service.readNote()');
    const read = await service.readNote('Memory/smoke/Notes/ServerHello.md');
    assert.equal(read.title, 'ServerHello');
    assert.ok(read.tags.includes('server-mode'));

    step('Reload from DB carries the note');
    const reloadService = new SynaipseService(config, {
        notes: bundle.notes,
        chats: bundle.chats,
        history: new NoopHistory(),
        skipWatcher: true
    });
    // Note: same adapter instance — Service.start() calls notes.load()
    // which re-reads the DB. Verifies the load path doesn't lose state.
    await reloadService.start();
    assert.equal(reloadService.listNotes().length, 1);

    step('historyEnabled() returns false under NoopHistory');
    assert.equal(await service.historyEnabled(), false);

    step('noteHistory() returns empty array under NoopHistory');
    assert.deepEqual(await service.noteHistory('Memory/smoke/Notes/ServerHello.md'), []);

    step('Cleanup: delete the note');
    await service.deleteNote('Memory/smoke/Notes/ServerHello.md');
    assert.equal(service.listNotes().length, 0);

    console.error('\n✓ Server-mode boot smoke passed');
} catch (err) {
    ok = false;
    console.error('\n✗ FAILED:', err);
} finally {
    if (service !== undefined) {
        await service.stop().catch(() => {});
    }
    if (bundle !== undefined) {
        await bundle.close();
    }
    rmSync(dummyVault, {recursive: true, force: true});
    process.exit(ok ? 0 : 1);
}