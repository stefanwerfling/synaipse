import {describe, it, expect} from 'vitest';
import {InMemoryAccountStore} from './InMemoryAccountStore.js';

describe('InMemoryAccountStore', () => {
    it('creates an account with hashed password and returns sanitized record', async () => {
        const store = new InMemoryAccountStore();
        const account = await store.create({
            email: 'admin@example.com',
            password: 'hunter2',
            isAdmin: true
        });

        expect(account.email).toBe('admin@example.com');
        expect(account.isAdmin).toBe(true);
        expect(account.id).toBeGreaterThan(0);
        expect(account.lastLoginAt).toBeNull();
        expect(account.disabledAt).toBeNull();
        // password material must not appear on the returned record
        expect(account as unknown as Record<string, unknown>).not.toHaveProperty('hashHex');
        expect(account as unknown as Record<string, unknown>).not.toHaveProperty('password');
    });

    it('defaults isAdmin to false when omitted', async () => {
        const store = new InMemoryAccountStore();
        const account = await store.create({email: 'a@b.com', password: 'pw'});
        expect(account.isAdmin).toBe(false);
    });

    it('rejects duplicate emails within the same store', async () => {
        const store = new InMemoryAccountStore();
        await store.create({email: 'dup@example.com', password: 'pw1'});
        await expect(store.create({email: 'dup@example.com', password: 'pw2'}))
            .rejects.toThrowError(/already exists/);
    });

    it('findByEmail returns the matching record or null', async () => {
        const store = new InMemoryAccountStore();
        const created = await store.create({email: 'find@me.com', password: 'pw'});
        const found = await store.findByEmail('find@me.com');
        expect(found?.id).toBe(created.id);
        expect(await store.findByEmail('missing@nowhere.com')).toBeNull();
    });

    it('findById returns the matching record or null', async () => {
        const store = new InMemoryAccountStore();
        const created = await store.create({email: 'id@example.com', password: 'pw'});
        expect((await store.findById(created.id))?.email).toBe('id@example.com');
        expect(await store.findById(99999)).toBeNull();
    });

    it('verifyLogin accepts correct password and rejects wrong one', async () => {
        const store = new InMemoryAccountStore();
        await store.create({email: 'login@example.com', password: 'right'});

        expect((await store.verifyLogin('login@example.com', 'right'))?.email).toBe('login@example.com');
        expect(await store.verifyLogin('login@example.com', 'wrong')).toBeNull();
    });

    it('verifyLogin returns null for unknown email (no enumeration oracle)', async () => {
        const store = new InMemoryAccountStore();
        await store.create({email: 'real@example.com', password: 'pw'});
        expect(await store.verifyLogin('ghost@example.com', 'whatever')).toBeNull();
    });

    it('verifyLogin returns null when the account is disabled', async () => {
        const store = new InMemoryAccountStore();
        const a = await store.create({email: 'disabled@example.com', password: 'pw'});
        await store.setDisabled(a.id, true);
        expect(await store.verifyLogin('disabled@example.com', 'pw')).toBeNull();
    });

    it('setDisabled toggles the disabledAt timestamp', async () => {
        const store = new InMemoryAccountStore();
        const a = await store.create({email: 'x@example.com', password: 'pw'});

        expect(await store.setDisabled(a.id, true)).toBe(true);
        expect((await store.findById(a.id))?.disabledAt).not.toBeNull();

        expect(await store.setDisabled(a.id, false)).toBe(true);
        expect((await store.findById(a.id))?.disabledAt).toBeNull();
    });

    it('setDisabled returns false for unknown id', async () => {
        const store = new InMemoryAccountStore();
        expect(await store.setDisabled(99999, true)).toBe(false);
    });

    it('setAdmin flips the is_admin flag', async () => {
        const store = new InMemoryAccountStore();
        const a = await store.create({email: 'u@example.com', password: 'pw'});
        expect(a.isAdmin).toBe(false);

        await store.setAdmin(a.id, true);
        expect((await store.findById(a.id))?.isAdmin).toBe(true);

        await store.setAdmin(a.id, false);
        expect((await store.findById(a.id))?.isAdmin).toBe(false);
    });

    it('setPassword changes the verifyLogin outcome', async () => {
        const store = new InMemoryAccountStore();
        const a = await store.create({email: 'p@example.com', password: 'old'});

        expect(await store.verifyLogin('p@example.com', 'old')).not.toBeNull();
        await store.setPassword(a.id, 'new');
        expect(await store.verifyLogin('p@example.com', 'old')).toBeNull();
        expect(await store.verifyLogin('p@example.com', 'new')).not.toBeNull();
    });

    it('setPassword returns false for unknown id', async () => {
        const store = new InMemoryAccountStore();
        expect(await store.setPassword(99999, 'pw')).toBe(false);
    });

    it('touchLastLogin updates lastLoginAt', async () => {
        const store = new InMemoryAccountStore();
        const a = await store.create({email: 't@example.com', password: 'pw'});
        expect(a.lastLoginAt).toBeNull();

        await store.touchLastLogin(a.id);
        const after = await store.findById(a.id);
        expect(after?.lastLoginAt).not.toBeNull();
    });

    it('listAccounts returns all created accounts', async () => {
        const store = new InMemoryAccountStore();
        await store.create({email: 'a@x.com', password: 'pw'});
        await store.create({email: 'b@x.com', password: 'pw'});
        const all = await store.listAccounts();
        expect(all.map((a) => a.email).sort()).toEqual(['a@x.com', 'b@x.com']);
    });
});