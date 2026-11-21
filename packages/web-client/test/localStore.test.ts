import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
    getStorageNamespace, keysWithPrefix, readItem, removeItem, setStorageNamespace, storageKey, writeItem
} from '../src/LocalStore.js';
import {PersistentValue} from '../src/Persistence.js';
import {clearDraft, listDraftIds, readDraft, writeDraft} from '../src/Drafts.js';

/** Plan E1: localStorage keys with a per-instance namespace. */

class MemoryStorage implements Storage {
    private readonly map = new Map<string, string>();
    public get length(): number {
        return this.map.size;
    }
    public clear(): void {
        this.map.clear();
    }
    public getItem(key: string): string | null {
        return this.map.get(key) ?? null;
    }
    public key(index: number): string | null {
        return [...this.map.keys()][index] ?? null;
    }
    public removeItem(key: string): void {
        this.map.delete(key);
    }
    public setItem(key: string, value: string): void {
        this.map.set(key, String(value));
    }
    public keys(): string[] {
        return [...this.map.keys()].sort();
    }
}

let store: MemoryStorage;

const install = (value: unknown): void => {
    Object.defineProperty(globalThis, 'localStorage', {value, configurable: true, writable: true});
};

beforeEach(() => {
    store = new MemoryStorage();
    install(store);
});

afterEach(() => {
    setStorageNamespace(undefined);
    delete (globalThis as {localStorage?: unknown}).localStorage;
});

describe('storageKey', () => {
    it('keeps the standalone keys without a namespace', () => {
        expect(getStorageNamespace()).toBeNull();
        expect(storageKey('synaipse.graph.positions')).toBe('synaipse.graph.positions');
        expect(storageKey('synaipse-theme')).toBe('synaipse-theme');
    });

    it('moves both legacy key shapes under synaipse:<namespace>:', () => {
        setStorageNamespace('pkg');
        expect(storageKey('synaipse.graph.positions')).toBe('synaipse:pkg:graph.positions');
        expect(storageKey('synaipse-theme')).toBe('synaipse:pkg:theme');
        expect(storageKey('synaipse.editor.draft:')).toBe('synaipse:pkg:editor.draft:');
    });

    it('rejects a bad namespace and keeps the current one', () => {
        setStorageNamespace('a');
        for (const bad of ['a:b', 'has space', 'ü', 'x'.repeat(65)]) {
            expect(() => setStorageNamespace(bad)).toThrow(TypeError);
        }
        expect(getStorageNamespace()).toBe('a');
        setStorageNamespace('');
        expect(getStorageNamespace()).toBeNull();
    });
});

describe('item helpers', () => {
    it('keep namespaces and the standalone keys apart', () => {
        writeItem('synaipse.rm.view', 'graph');
        setStorageNamespace('one');
        expect(readItem('synaipse.rm.view')).toBeNull();
        writeItem('synaipse.rm.view', 'table');
        setStorageNamespace('two');
        expect(readItem('synaipse.rm.view')).toBeNull();
        setStorageNamespace('one');
        expect(readItem('synaipse.rm.view')).toBe('table');
        removeItem('synaipse.rm.view');
        setStorageNamespace(undefined);
        expect(readItem('synaipse.rm.view')).toBe('graph');
        expect(store.keys()).toEqual(['synaipse.rm.view']);
    });

    it('lists drafts of the current namespace only', () => {
        const draft = {title: 't', tags: '', content: 'c', savedAt: 1};
        writeDraft('a.md', draft);
        setStorageNamespace('pkg');
        writeDraft('b.md', draft);
        writeDraft('c.md', draft);
        clearDraft('c.md');
        expect([...listDraftIds()]).toEqual(['b.md']);
        expect(readDraft('a.md')).toBeNull();
        setStorageNamespace(undefined);
        expect([...listDraftIds()]).toEqual(['a.md']);
        expect(keysWithPrefix('synaipse.editor.draft:')).toEqual(['a.md']);
    });

    it('treat blocked storage as empty', () => {
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            get: () => {
                throw new Error('SecurityError');
            }
        });
        expect(readItem('synaipse.locale')).toBeNull();
        expect(() => writeItem('synaipse.locale', 'de')).not.toThrow();
        expect(keysWithPrefix('synaipse.')).toEqual([]);
        const value = new PersistentValue<number>('synaipse.n', 3);
        value.set(4);
        expect(value.get()).toBe(4);
        value.destroy();
    });
});

describe('PersistentValue and the namespace', () => {
    it('a value loaded before mount moves to the namespace without writing its default', () => {
        store.setItem('synaipse.graph.hideIsolated', 'true');
        store.setItem('synaipse:pkg:graph.hideIsolated', 'false');
        // Module-level values are created at import, before mount() runs.
        const value = new PersistentValue<boolean>('synaipse.graph.hideIsolated', false);
        const seen: boolean[] = [];
        value.subscribe((v) => seen.push(v));
        expect(value.get()).toBe(true);

        setStorageNamespace('pkg');
        expect(value.get()).toBe(false);
        expect(seen).toEqual([false]);

        value.set(true);
        expect(store.getItem('synaipse:pkg:graph.hideIsolated')).toBe('true');
        expect(store.getItem('synaipse.graph.hideIsolated')).toBe('true');
        expect(store.keys()).toEqual(['synaipse.graph.hideIsolated', 'synaipse:pkg:graph.hideIsolated']);
        value.destroy();
    });

    it('a namespace that starts empty gives the initial value, not the standalone one', () => {
        store.setItem('synaipse.notes.groupMode', '"tag"');
        const value = new PersistentValue<string>('synaipse.notes.groupMode', 'folder');
        const neverSet = new PersistentValue<number>('synaipse.notes.sidebarWidth', 280);
        setStorageNamespace('fresh');
        expect(value.get()).toBe('folder');
        expect(neverSet.get()).toBe(280);
        expect(store.keys()).toEqual(['synaipse.notes.groupMode']);
        value.destroy();
        neverSet.destroy();
    });

    it('a destroyed value no longer follows the namespace', () => {
        const value = new PersistentValue<number>('synaipse.x', 1);
        value.set(2);
        value.destroy();
        setStorageNamespace('later');
        expect(value.get()).toBe(2);
    });
});
