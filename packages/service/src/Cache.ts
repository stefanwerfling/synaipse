import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

export interface CacheEntry {
    hash: string;
    mtime: number;
}

export class HashCache {
    private data = new Map<string, CacheEntry>();
    private dirty = false;
    private flushTimer: NodeJS.Timeout | null = null;
    private flushing: Promise<void> | null = null;

    public constructor(
        private readonly file: string,
        private readonly debounceMs: number = 500
    ) {}

    public async load(): Promise<void> {
        if (!existsSync(this.file)) {
            return;
        }

        try {
            const raw = await readFile(this.file, 'utf8');
            const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
            this.data = new Map(Object.entries(parsed));
        } catch {
            this.data = new Map();
        }
    }

    public get(id: string): CacheEntry | undefined {
        return this.data.get(id);
    }

    public has(id: string): boolean {
        return this.data.has(id);
    }

    public ids(): string[] {
        return [...this.data.keys()];
    }

    public size(): number {
        return this.data.size;
    }

    public set(id: string, entry: CacheEntry): void {
        const prev = this.data.get(id);

        if (prev && prev.hash === entry.hash && prev.mtime === entry.mtime) {
            return;
        }

        this.data.set(id, entry);
        this.schedule();
    }

    public delete(id: string): void {
        if (!this.data.delete(id)) {
            return;
        }

        this.schedule();
    }

    public async flush(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        if (this.flushing) {
            await this.flushing;
            return;
        }

        if (!this.dirty) {
            return;
        }

        this.flushing = this.writeFile();

        try {
            await this.flushing;
        } finally {
            this.flushing = null;
        }
    }

    private schedule(): void {
        this.dirty = true;

        if (this.flushTimer) {
            return;
        }

        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush().catch(() => {
                // best-effort; next mutation reschedules
            });
        }, this.debounceMs);
    }

    private async writeFile(): Promise<void> {
        this.dirty = false;
        await mkdir(path.dirname(this.file), {recursive: true});
        const obj: Record<string, CacheEntry> = Object.fromEntries(this.data);
        await writeFile(this.file, JSON.stringify(obj, null, 2), 'utf8');
    }
}