import {randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';

// scrypt cost parameters. N=2^14 ≈ 50ms on modern hardware. Bearer tokens
// have 256 bits of entropy from randomBytes(32), so we don't need a slow
// password-grade KDF — N=2^14 is well above the brute-force horizon for
// hashes of that size, and keeps per-request auth latency tolerable.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const HASH_LEN_BYTES = 64;
const SALT_LEN_BYTES = 16;
const TOKEN_BYTES = 32;
const HINT_LEN = 8;

export interface GeneratedToken {
    /** Plain text token — shown once to the operator, never persisted. */
    plain: string;
    hashHex: string;
    saltHex: string;
    /** First HINT_LEN chars of the plain token — safe to log / display. */
    hint: string;
}

const hashToken = (plain: string, saltHex: string): string => {
    const salt = Buffer.from(saltHex, 'hex');
    const derived = scryptSync(plain, salt, HASH_LEN_BYTES, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P
    });

    return derived.toString('hex');
};

export const generateToken = (): GeneratedToken => {
    const plain = randomBytes(TOKEN_BYTES).toString('base64url');
    const saltHex = randomBytes(SALT_LEN_BYTES).toString('hex');
    const hashHex = hashToken(plain, saltHex);

    return {plain, hashHex, saltHex, hint: plain.slice(0, HINT_LEN)};
};

/**
 * Verify a candidate plaintext token against a stored hash + salt.
 * timing-safe via crypto.timingSafeEqual. Returns false on any malformed
 * input rather than throwing — verification failures look identical to
 * legitimate mismatches from the caller's point of view.
 */
export const verifyToken = (plain: string, hashHex: string, saltHex: string): boolean => {
    if (plain.length === 0 || hashHex.length === 0 || saltHex.length === 0) {
        return false;
    }

    let candidateBuf: Buffer;
    let expectedBuf: Buffer;

    try {
        candidateBuf = Buffer.from(hashToken(plain, saltHex), 'hex');
        expectedBuf = Buffer.from(hashHex, 'hex');
    } catch {
        return false;
    }

    if (candidateBuf.length !== expectedBuf.length) {
        return false;
    }

    return timingSafeEqual(candidateBuf, expectedBuf);
};

export const hintOf = (plain: string): string => plain.slice(0, HINT_LEN);