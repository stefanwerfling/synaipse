import {EventEmitter} from 'node:events';
import chokidar, {FSWatcher} from 'chokidar';
import type {VaultEvent} from '@synaipse/core';

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
            ignored: (p) => /(?:^|[\\/])(?:\.git|\.obsidian|node_modules|\.trash)(?:[\\/]|$)/.test(p),
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