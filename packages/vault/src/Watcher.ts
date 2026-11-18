import {EventEmitter} from 'node:events';
import path from 'node:path';
import chokidar, {FSWatcher} from 'chokidar';
import type {VaultEvent} from '@synaipse/core';
import {isIgnoredPath} from './Walker.js';

export class VaultWatcher extends EventEmitter {
    private watcher: FSWatcher | null = null;

    public constructor(private readonly vaultRoot: string) {
        super();
    }

    public start(): void {
        if (this.watcher) {
            return;
        }

        this.watcher = chokidar.watch(this.vaultRoot, {
            // Same rule as the initial scan (Walker.isIgnoredDir) — anything excluded from the
            // initial scan must also be excluded from live events, or the
            // chat sidecar (`.synaipse-chats/`) gets pulled into the vault
            // state every time we write a chat file. Checked relative to the
            // vault root, so a vault that itself lives under a dot-folder works.
            ignored: (p) => isIgnoredPath(path.relative(this.vaultRoot, p)),
            ignoreInitial: true,
            persistent: true,
            awaitWriteFinish: {stabilityThreshold: 200, pollInterval: 50}
        });

        this.watcher.on('add', (p) => this.emitIfMarkdown('created', p));
        this.watcher.on('change', (p) => this.emitIfMarkdown('updated', p));
        this.watcher.on('unlink', (p) => this.emitIfMarkdown('deleted', p));
    }

    public async stop(): Promise<void> {
        if (!this.watcher) {
            return;
        }

        await this.watcher.close();
        this.watcher = null;
    }

    private emitIfMarkdown(kind: VaultEvent['kind'], p: string): void {
        if (!p.endsWith('.md')) {
            return;
        }

        const event: VaultEvent = {kind, path: p};
        this.emit('event', event);
    }
}