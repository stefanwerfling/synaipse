import {describe, it, expect} from 'vitest';
import {generatePasswordHash, verifyPassword} from '../src/PasswordHash.js';

describe('generatePasswordHash', () => {
    it('produces a 128-char hex hash + 32-char hex salt', () => {
        const h = generatePasswordHash('correct-horse-battery-staple');
        expect(h.hashHex).toMatch(/^[0-9a-f]{128}$/);
        expect(h.saltHex).toMatch(/^[0-9a-f]{32}$/);
    });

    it('produces a different salt every call', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 8; i++) {
            seen.add(generatePasswordHash('same').saltHex);
        }
        expect(seen.size).toBe(8);
    });

    it('produces a different hash every call (because salt differs)', () => {
        const a = generatePasswordHash('same');
        const b = generatePasswordHash('same');
        expect(a.hashHex).not.toBe(b.hashHex);
    });

    it('rejects empty passwords with an explicit error', () => {
        expect(() => generatePasswordHash('')).toThrowError(/empty/);
    });
});

describe('verifyPassword', () => {
    it('accepts the matching password', () => {
        const h = generatePasswordHash('hunter2');
        expect(verifyPassword('hunter2', h.hashHex, h.saltHex)).toBe(true);
    });

    it('rejects a wrong password', () => {
        const h = generatePasswordHash('hunter2');
        expect(verifyPassword('hunter3', h.hashHex, h.saltHex)).toBe(false);
    });

    it('rejects an empty password without throwing', () => {
        const h = generatePasswordHash('hunter2');
        expect(verifyPassword('', h.hashHex, h.saltHex)).toBe(false);
    });

    it('rejects when the salt does not match the hash', () => {
        const a = generatePasswordHash('hunter2');
        const b = generatePasswordHash('hunter2');
        expect(verifyPassword('hunter2', a.hashHex, b.saltHex)).toBe(false);
    });

    it('rejects malformed hex without throwing', () => {
        const h = generatePasswordHash('hunter2');
        expect(verifyPassword('hunter2', 'not-hex', h.saltHex)).toBe(false);
        expect(verifyPassword('hunter2', h.hashHex, 'not-hex')).toBe(false);
    });
});