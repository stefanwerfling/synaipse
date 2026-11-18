import {randomBytes, scrypt, scryptSync, timingSafeEqual} from 'node:crypto';

// Same scrypt cost parameters as TokenHash. Passwords have far less
// entropy than 256-bit bearer tokens, so a stronger N would be defensible
// here — but ~50ms is also the latency budget operators tolerate on
// interactive login. If brute-force pressure becomes a concern, bump
// SCRYPT_N here independently from TokenHash.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const HASH_LEN_BYTES = 64;
const SALT_LEN_BYTES = 16;

export interface HashedPassword {
    hashHex: string;
    saltHex: string;
}

const hashPassword = (plain: string, saltHex: string): string => {
    const salt = Buffer.from(saltHex, 'hex');
    const derived = scryptSync(plain, salt, HASH_LEN_BYTES, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P
    });

    return derived.toString('hex');
};

export const generatePasswordHash = (plain: string): HashedPassword => {
    if (plain.length === 0) {
        throw new Error('password must not be empty');
    }

    const saltHex = randomBytes(SALT_LEN_BYTES).toString('hex');
    const hashHex = hashPassword(plain, saltHex);
    return {hashHex, saltHex};
};

/**
 * Timing-safe password verification. Returns false on any malformed
 * input rather than throwing — failures look identical to legitimate
 * mismatches from the caller's point of view.
 */
export const verifyPassword = (plain: string, hashHex: string, saltHex: string): boolean => {
    if (plain.length === 0 || hashHex.length === 0 || saltHex.length === 0) {
        return false;
    }

    let candidateBuf: Buffer;
    let expectedBuf: Buffer;

    try {
        candidateBuf = Buffer.from(hashPassword(plain, saltHex), 'hex');
        expectedBuf = Buffer.from(hashHex, 'hex');
    } catch {
        return false;
    }

    if (candidateBuf.length !== expectedBuf.length) {
        return false;
    }

    return timingSafeEqual(candidateBuf, expectedBuf);
};

/**
 * Non-blocking variant of {@link verifyPassword}. scrypt at N=2^14 costs ~50 ms of
 * CPU; the sync version blocks the event loop for that long on every
 * auth miss, which stalls every other request (MCP included). Request
 * paths must use this one; the sync variant stays for CLIs and tests.
 */
export const verifyPasswordAsync = async (plain: string, hashHex: string, saltHex: string): Promise<boolean> => {
    if (plain.length === 0 || hashHex.length === 0 || saltHex.length === 0) {
        return false;
    }

    let expectedBuf: Buffer;
    let salt: Buffer;
    try {
        expectedBuf = Buffer.from(hashHex, 'hex');
        salt = Buffer.from(saltHex, 'hex');
    } catch {
        return false;
    }

    if (expectedBuf.length !== HASH_LEN_BYTES) {
        return false;
    }

    const candidateBuf = await new Promise<Buffer | null>((resolve) => {
        scrypt(plain, salt, HASH_LEN_BYTES, {N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P}, (err, derived) => {
            resolve(err ? null : derived);
        });
    });

    if (candidateBuf === null) {
        return false;
    }

    return timingSafeEqual(candidateBuf, expectedBuf);
};
