import {describe, it, expect} from 'vitest';
import {decodeStorageEvent, setCodec, StorageEventLike} from '../src/Persistence.js';

describe('setCodec', () => {
    it('serializes a Set to a JSON array', () => {
        expect(setCodec.serialize(new Set(['a', 'b']))).toMatch(/^\["a","b"\]$|^\["b","a"\]$/);
    });

    it('serializes an empty Set', () => {
        expect(setCodec.serialize(new Set())).toBe('[]');
    });

    it('deserializes a JSON array back into a Set', () => {
        const result = setCodec.deserialize('["a","b"]');
        expect(result).toBeInstanceOf(Set);
        expect([...result].sort()).toEqual(['a', 'b']);
    });

    it('deserializes an empty array', () => {
        expect(setCodec.deserialize('[]').size).toBe(0);
    });

    it('drops non-string entries from input array', () => {
        const result = setCodec.deserialize('["ok", 42, null, "yes"]');
        expect([...result].sort()).toEqual(['ok', 'yes']);
    });

    it('round-trips through serialize → deserialize', () => {
        const original = new Set(['typescript', 'docker', 'adr']);
        const round = setCodec.deserialize(setCodec.serialize(original));
        expect([...round].sort()).toEqual([...original].sort());
    });

    it('throws on non-array JSON', () => {
        expect(() => setCodec.deserialize('{"a":1}')).toThrow();
    });

    it('throws on invalid JSON', () => {
        expect(() => setCodec.deserialize('not json')).toThrow();
    });
});

describe('decodeStorageEvent', () => {
    const jsonCodec = {
        serialize: (n: number) => JSON.stringify(n),
        deserialize: (raw: string): number => JSON.parse(raw) as number
    };
    const fakeStorage = {} as Storage;
    const otherStorage = {} as Storage;
    const key = 'synaipse.k';

    const event = (overrides: Partial<StorageEventLike>): StorageEventLike => ({
        storageArea: fakeStorage,
        key,
        newValue: '42',
        ...overrides
    });

    it('returns set for matching key with new value', () => {
        const d = decodeStorageEvent(event({}), fakeStorage, key, 0, jsonCodec);
        expect(d).toEqual({kind: 'set', value: 42});
    });

    it('ignores events from a different storage area', () => {
        const d = decodeStorageEvent(event({storageArea: otherStorage}), fakeStorage, key, 0, jsonCodec);
        expect(d).toEqual({kind: 'ignore'});
    });

    it('ignores unrelated keys', () => {
        const d = decodeStorageEvent(event({key: 'other'}), fakeStorage, key, 0, jsonCodec);
        expect(d).toEqual({kind: 'ignore'});
    });

    it('treats key === null as a clear() and resets to initial', () => {
        const d = decodeStorageEvent(event({key: null}), fakeStorage, key, 7, jsonCodec);
        expect(d).toEqual({kind: 'reset', value: 7});
    });

    it('treats newValue === null as a removeItem and resets to initial', () => {
        const d = decodeStorageEvent(event({newValue: null}), fakeStorage, key, 7, jsonCodec);
        expect(d).toEqual({kind: 'reset', value: 7});
    });

    it('ignores corrupted payloads instead of resetting', () => {
        const d = decodeStorageEvent(event({newValue: 'not json'}), fakeStorage, key, 0, jsonCodec);
        expect(d).toEqual({kind: 'ignore'});
    });

    it('skips storage-area check when targetStorage is null', () => {
        const d = decodeStorageEvent(event({storageArea: otherStorage}), null, key, 0, jsonCodec);
        expect(d).toEqual({kind: 'set', value: 42});
    });
});