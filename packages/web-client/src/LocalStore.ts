/**
 * Every localStorage access of the web UI goes through here (plan E1).
 *
 * Standalone, and embedded without `storageNamespace`, the keys are the
 * ones Synaipse always used (`synaipse.graph.positions`, `synaipse-theme`),
 * so stored preferences and drafts survive the update. With a namespace,
 * `mount({storageNamespace: 'pkg'})` turns them into `synaipse:pkg:graph.positions`:
 * two Synaipse UIs on one origin (say, against two vaults) then keep their
 * drafts, layouts and collapse states apart. The two key shapes cannot
 * collide (`.`/`-` versus `:` after `synaipse`).
 *
 * Module-level state like the API base: one namespace per page, set by
 * mount(). Values already loaded (module-level PersistentValues) reload
 * when it changes, see onStorageNamespaceChange().
 *
 * Every helper is best-effort: storage that is missing, blocked (private
 * mode, sandboxed iframe) or full reads as empty and drops writes.
 */

const NAMESPACE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LEGACY_PREFIX_RE = /^synaipse[.-]/;

let namespace: string | null = null;
const listeners = new Set<() => void>();

/**
 * Set (or with undefined/'' clear) the key namespace. Letters, digits,
 * `_` and `-`, at most 64; anything else throws, so a host's typo does not
 * silently share or lose state.
 */
export const setStorageNamespace = (raw: string | undefined): void => {
    const next = raw === undefined || raw === '' ? null : raw;

    if (next !== null && !NAMESPACE_RE.test(next)) {
        throw new TypeError(`storageNamespace must match ${NAMESPACE_RE.source}, got ${JSON.stringify(raw)}`);
    }

    if (next === namespace) {
        return;
    }

    namespace = next;
    for (const listener of [...listeners]) listener();
};

export const getStorageNamespace = (): string | null => namespace;

/** Called after the namespace changed. Returns the unsubscribe. */
export const onStorageNamespaceChange = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/** The stored key for a Synaipse key (`synaipse.x` / `synaipse-x`). */
export const storageKey = (key: string): string =>
    namespace === null ? key : `synaipse:${namespace}:${key.replace(LEGACY_PREFIX_RE, '')}`;

/** localStorage, or null where it is missing or access throws. */
export const storageArea = (): Storage | null => {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
};

export const readItem = (key: string): string | null => {
    try {
        return storageArea()?.getItem(storageKey(key)) ?? null;
    } catch {
        return null;
    }
};

export const writeItem = (key: string, value: string): void => {
    try {
        storageArea()?.setItem(storageKey(key), value);
    } catch {
        // quota or blocked: the value lasts for this page only
    }
};

export const removeItem = (key: string): void => {
    try {
        storageArea()?.removeItem(storageKey(key));
    } catch {
        // ignore
    }
};

/** The rest of every stored key that starts with `prefix` (in this namespace). */
export const keysWithPrefix = (prefix: string): string[] => {
    const scoped = storageKey(prefix);
    const out: string[] = [];

    try {
        const area = storageArea();
        if (area === null) return out;
        for (let i = 0; i < area.length; i += 1) {
            const k = area.key(i);
            if (k !== null && k.startsWith(scoped)) out.push(k.slice(scoped.length));
        }
    } catch {
        // unavailable: nothing stored
    }

    return out;
};
