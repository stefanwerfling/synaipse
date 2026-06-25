import {describe, it, expect} from 'vitest';
import {generateToken, verifyToken, hintOf} from '../src/TokenHash.js';

describe('generateToken', () => {
    it('produces a 43-char base64url plain token', () => {
        const t = generateToken();
        // base64url(32 bytes) = 43 chars, no padding
        expect(t.plain).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('produces a 128-char hex hash + 32-char hex salt', () => {
        const t = generateToken();
        expect(t.hashHex).toMatch(/^[0-9a-f]{128}$/);
        expect(t.saltHex).toMatch(/^[0-9a-f]{32}$/);
    });

    it('produces unique tokens across calls', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 16; i++) {
            seen.add(generateToken().plain);
        }
        expect(seen.size).toBe(16);
    });

    it('exposes an 8-char hint matching the plain prefix', () => {
        const t = generateToken();
        expect(t.hint).toBe(t.plain.slice(0, 8));
        expect(t.hint.length).toBe(8);
    });
});

describe('verifyToken', () => {
    it('accepts the matching plain token', () => {
        const t = generateToken();
        expect(verifyToken(t.plain, t.hashHex, t.saltHex)).toBe(true);
    });

    it('rejects a wrong plain token of the same length', () => {
        const t = generateToken();
        const tampered = t.plain.slice(0, 42) + (t.plain.at(-1) === 'A' ? 'B' : 'A');
        expect(verifyToken(tampered, t.hashHex, t.saltHex)).toBe(false);
    });

    it('rejects when the salt does not match the hash', () => {
        const a = generateToken();
        const b = generateToken();
        expect(verifyToken(a.plain, a.hashHex, b.saltHex)).toBe(false);
    });

    it('rejects empty inputs without throwing', () => {
        const t = generateToken();
        expect(verifyToken('', t.hashHex, t.saltHex)).toBe(false);
        expect(verifyToken(t.plain, '', t.saltHex)).toBe(false);
        expect(verifyToken(t.plain, t.hashHex, '')).toBe(false);
    });

    it('rejects malformed hex without throwing', () => {
        const t = generateToken();
        expect(verifyToken(t.plain, 'not-hex', t.saltHex)).toBe(false);
    });
});

describe('hintOf', () => {
    it('returns the first 8 characters of the input', () => {
        expect(hintOf('abcdefghij')).toBe('abcdefgh');
    });

    it('returns the whole string when shorter than 8', () => {
        expect(hintOf('xyz')).toBe('xyz');
    });
});