import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {appendFile, mkdir, mkdtemp, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {VaultEvent} from '@synaipse/core';
import {VaultWatcher} from '../src/Watcher.js';

const STABILITY = 60;

for (const recursive of [false, true]) {
    describe(`VaultWatcher (${recursive ? 'one recursive watch' : 'one watch per directory'})`, () => {
        let root: string;
        let outside: string;
        let watcher: VaultWatcher;
        let events: Array<[VaultEvent['kind'], string]>;

        const rel = (p: string): string => path.relative(root, p).split(path.sep).join('/');
        const put = async (p: string, body = 'x'): Promise<void> => {
            await mkdir(path.dirname(path.join(root, p)), {recursive: true});
            await writeFile(path.join(root, p), body, 'utf8');
        };
        /** Wait until `expected` arrived, then a little longer to catch extra events. */
        const settle = async (expected: Array<[VaultEvent['kind'], string]>): Promise<void> => {
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline && !expected.every((e) => events.some((x) => x[0] === e[0] && x[1] === e[1]))) {
                await new Promise((r) => setTimeout(r, 20));
            }
            await new Promise((r) => setTimeout(r, STABILITY * 4));
            expect([...events].sort()).toEqual([...expected].sort());
            events.length = 0;
        };
        /** The initial walk runs in the background; a known file proves it has passed. */
        const ready = async (): Promise<void> => {
            await put('zz-ready.md', 'r');
            await settle([['created', 'zz-ready.md']]);
        };

        beforeEach(async () => {
            const base = await realpath(await mkdtemp(path.join(tmpdir(), 'synaipse-watch-')));
            root = path.join(base, 'vault');
            outside = path.join(base, 'outside');
            await mkdir(outside, {recursive: true});
            await put('a.md', 'a');
            await put('deep/b.md', 'b');
            await put('.synaipse/state.md', 's');
            events = [];
            watcher = new VaultWatcher(root, {stabilityMs: STABILITY, recursive});
            watcher.on('event', (e: VaultEvent) => events.push([e.kind, rel(e.path)]));
            watcher.start();
            await ready();
        });

        afterEach(async () => {
            await watcher.stop();
            await rm(path.dirname(root), {recursive: true, force: true});
        });

        it('reports nothing for notes that existed before start', async () => {
            await settle([]);
        });

        it('reports created, updated and deleted notes', async () => {
            await put('new.md', 'n');
            await settle([['created', 'new.md']]);
            await put('deep/b.md', 'changed');
            await settle([['updated', 'deep/b.md']]);
            await rm(path.join(root, 'a.md'));
            await settle([['deleted', 'a.md']]);
        });

        it('reports a file written in pieces once, when it is complete', async () => {
            await put('slow.md', 'part 1');
            for (let i = 2; i <= 5; i++) {
                await new Promise((r) => setTimeout(r, STABILITY / 4));
                await appendFile(path.join(root, 'slow.md'), ` part ${i}`);
            }
            await settle([['created', 'slow.md']]);
        });

        it('sees notes in new and moved-in folders, and the removal of a folder', async () => {
            await put('fresh/dir/c.md', 'c');
            await settle([['created', 'fresh/dir/c.md']]);
            await put('fresh/dir/c.md', 'c2');
            await settle([['updated', 'fresh/dir/c.md']]);

            await mkdir(path.join(outside, 'pkg/sub'), {recursive: true});
            await writeFile(path.join(outside, 'pkg/one.md'), '1');
            await writeFile(path.join(outside, 'pkg/sub/two.md'), '2');
            await rename(path.join(outside, 'pkg'), path.join(root, 'pkg'));
            await settle([['created', 'pkg/one.md'], ['created', 'pkg/sub/two.md']]);

            await rm(path.join(root, 'pkg'), {recursive: true});
            await settle([['deleted', 'pkg/one.md'], ['deleted', 'pkg/sub/two.md']]);
        });

        it('reports a rename as delete plus create', async () => {
            await rename(path.join(root, 'deep/b.md'), path.join(root, 'deep/b2.md'));
            await settle([['deleted', 'deep/b.md'], ['created', 'deep/b2.md']]);
        });

        it('ignores sidecar folders and files that are not notes', async () => {
            await put('.synaipse/state.md', 'changed');
            await put('.git/x.md', 'x');
            await put('img.png', 'png');
            await put('deep/notes.txt', 't');
            await settle([]);
        });

        it('reports nothing after stop', async () => {
            await watcher.stop();
            await put('late.md', 'l');
            await settle([]);
        });
    });
}
