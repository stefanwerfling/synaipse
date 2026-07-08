import {describe, it, expect} from 'vitest';
import {ConsentStore} from '../src/ConsentStore.js';

describe('ConsentStore', () => {
    it('resolves granted decision to the waiting request()', async () => {
        const store = new ConsentStore();
        const p = store.request('Notes/a.md', 'clipper', 5_000);
        const [pending] = store.pending();
        expect(pending?.noteId).toBe('Notes/a.md');
        const resolved = store.resolve(pending!.id, 'granted');
        expect(resolved?.decision).toBe('granted');
        await expect(p).resolves.toBe('granted');
    });

    it('resolves denied decision', async () => {
        const store = new ConsentStore();
        const p = store.request('Notes/b.md', 'x', 5_000);
        const [pending] = store.pending();
        store.resolve(pending!.id, 'denied');
        await expect(p).resolves.toBe('denied');
    });

    it('returns "timeout" when nothing resolves in time', async () => {
        const store = new ConsentStore();
        await expect(store.request('Notes/c.md', 'x', 50)).resolves.toBe('timeout');
    });

    it('dedupes parallel requests for the same note into one record', async () => {
        const store = new ConsentStore();
        const p1 = store.request('Notes/d.md', 'r1', 5_000);
        const p2 = store.request('Notes/d.md', 'r2', 5_000);
        expect(store.pending()).toHaveLength(1);
        const [only] = store.pending();
        store.resolve(only!.id, 'granted');
        await expect(Promise.all([p1, p2])).resolves.toEqual(['granted', 'granted']);
    });

    it('emits "new" event when a request is created', () => {
        const store = new ConsentStore();
        const seen: string[] = [];
        store.onNew((r) => seen.push(r.noteId));
        void store.request('Notes/e.md', 'x', 5_000);
        expect(seen).toEqual(['Notes/e.md']);
    });

    it('emits "resolved" event on resolve', () => {
        const store = new ConsentStore();
        const seen: string[] = [];
        store.onResolved((r) => seen.push(`${r.noteId}:${r.decision}`));
        void store.request('Notes/f.md', 'x', 5_000);
        const [only] = store.pending();
        store.resolve(only!.id, 'granted');
        expect(seen).toEqual(['Notes/f.md:granted']);
    });

    it('resolve() is idempotent — double-approve returns null the second time', () => {
        const store = new ConsentStore();
        void store.request('Notes/g.md', 'x', 5_000);
        const [only] = store.pending();
        expect(store.resolve(only!.id, 'granted')).not.toBeNull();
        expect(store.resolve(only!.id, 'granted')).toBeNull();
        expect(store.resolve(only!.id, 'denied')).toBeNull();
    });

    it('unresolved request stays visible in pending() until resolved', () => {
        const store = new ConsentStore();
        void store.request('Notes/h.md', 'x', 5_000);
        expect(store.pending()).toHaveLength(1);
        const [only] = store.pending();
        store.resolve(only!.id, 'denied');
        expect(store.pending()).toHaveLength(0);
    });

    it('after a resolved decision, a new request for the same note creates a fresh record', () => {
        const store = new ConsentStore();
        void store.request('Notes/i.md', 'x', 5_000);
        const [first] = store.pending();
        store.resolve(first!.id, 'denied');

        void store.request('Notes/i.md', 'y', 5_000);
        const [second] = store.pending();
        expect(second?.id).not.toBe(first?.id);
        expect(second?.requester).toBe('y');
    });
});