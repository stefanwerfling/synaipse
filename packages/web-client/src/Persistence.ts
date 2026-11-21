import {onStorageNamespaceChange, storageArea, storageKey} from './LocalStore.js';

export interface StorageCodec<T> {
    serialize: (value: T) => string;
    deserialize: (raw: string) => T;
}

const defaultCodec = <T>(): StorageCodec<T> => ({
    serialize: (v) => JSON.stringify(v),
    deserialize: (raw) => JSON.parse(raw) as T
});

export const setCodec: StorageCodec<ReadonlySet<string>> = {
    serialize: (s) => JSON.stringify([...s]),
    deserialize: (raw) => {
        const parsed = JSON.parse(raw) as unknown;

        if (!Array.isArray(parsed)) {
            throw new Error('expected array');
        }

        return new Set(parsed.filter((v): v is string => typeof v === 'string'));
    }
};

/** `key` is the stored (already namespaced) key. */
const readInitial = <T>(key: string, initial: T, codec: StorageCodec<T>): T => {
    try {
        const raw = storageArea()?.getItem(key) ?? null;

        if (raw === null) {
            return initial;
        }

        return codec.deserialize(raw);
    } catch {
        return initial;
    }
};

export interface StorageEventLike {
    storageArea: Storage | null;
    key: string | null;
    newValue: string | null;
}

export type StorageEventDecision<T> =
    | {kind: 'ignore'}
    | {kind: 'reset'; value: T}
    | {kind: 'set'; value: T};

export const decodeStorageEvent = <T>(
    event: StorageEventLike,
    targetStorage: Storage | null,
    targetKey: string,
    initial: T,
    codec: StorageCodec<T>
): StorageEventDecision<T> => {
    if (targetStorage !== null && event.storageArea !== targetStorage) {
        return {kind: 'ignore'};
    }

    if (event.key === null) {
        return {kind: 'reset', value: initial};
    }

    if (event.key !== targetKey) {
        return {kind: 'ignore'};
    }

    if (event.newValue === null) {
        return {kind: 'reset', value: initial};
    }

    try {
        return {kind: 'set', value: codec.deserialize(event.newValue)};
    } catch {
        return {kind: 'ignore'};
    }
};

export class PersistentValue<T> {
    private current: T;
    private readonly listeners = new Set<(value: T) => void>();
    private readonly storageHandler: (event: StorageEvent) => void;
    private readonly unloadHandler: (() => void) | null = null;
    private readonly offNamespace: () => void;
    private persistTimer: number | null = null;
    /** The stored key: `name` in the current storage namespace (LocalStore). */
    private key: string;

    public constructor(
        private readonly name: string,
        private readonly initial: T,
        private readonly codec: StorageCodec<T> = defaultCodec<T>(),
        /** When > 0, persist() coalesces writes via a leading-edge timer.
         * Useful for high-frequency updates (e.g. live heat bumps) so we
         * don't JSON-stringify + localStorage.setItem on every call. */
        private readonly persistDebounceMs: number = 0
    ) {
        this.key = storageKey(name);
        this.current = readInitial(this.key, initial, codec);

        // Module-level values load at import, before mount() sets the
        // namespace: move over then. A pending write still goes to the old key.
        this.offNamespace = onStorageNamespaceChange(() => {
            if (this.persistTimer !== null) this.flush();
            this.key = storageKey(this.name);
            this.current = readInitial(this.key, this.initial, this.codec);
            this.emit();
        });

        this.storageHandler = (event) => {
            const target = storageArea();
            const decision = decodeStorageEvent(event, target, this.key, this.initial, this.codec);

            if (decision.kind === 'ignore') {
                return;
            }

            this.current = decision.value;
            this.emit();
        };

        if (typeof window !== 'undefined') {
            window.addEventListener('storage', this.storageHandler);

            if (this.persistDebounceMs > 0) {
                this.unloadHandler = () => this.flush();
                window.addEventListener('beforeunload', this.unloadHandler);
            }
        }
    }

    public get(): T {
        return this.current;
    }

    public set(value: T): void {
        this.current = value;
        this.persist();
        this.emit();
    }

    public update(fn: (prev: T) => T): void {
        this.set(fn(this.current));
    }

    public subscribe(listener: (value: T) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Force any pending debounced write to flush synchronously. */
    public flush(): void {
        if (this.persistTimer !== null) {
            if (typeof window !== 'undefined') {
                window.clearTimeout(this.persistTimer);
            }
            this.persistTimer = null;
        }
        this.persistNow();
    }

    public destroy(): void {
        this.flush();
        this.offNamespace();

        if (typeof window !== 'undefined') {
            window.removeEventListener('storage', this.storageHandler);

            if (this.unloadHandler !== null) {
                window.removeEventListener('beforeunload', this.unloadHandler);
            }
        }
        this.listeners.clear();
    }

    private persist(): void {
        if (this.persistDebounceMs <= 0 || typeof window === 'undefined') {
            this.persistNow();
            return;
        }

        // Leading-edge throttle: the first call schedules; subsequent calls
        // are no-ops until the timer fires. When it does, it serialises the
        // latest `this.current`, so no state is lost.
        if (this.persistTimer !== null) {
            return;
        }

        this.persistTimer = window.setTimeout(() => {
            this.persistTimer = null;
            this.persistNow();
        }, this.persistDebounceMs);
    }

    private persistNow(): void {
        try {
            storageArea()?.setItem(this.key, this.codec.serialize(this.current));
        } catch {
            // best-effort
        }
    }

    private emit(): void {
        for (const listener of this.listeners) {
            listener(this.current);
        }
    }
}