import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {VoyageEmbedder, parseRetryAfter} from '../src/Embeddings.js';

const okBody = (n: number): string => JSON.stringify({
    data: Array.from({length: n}, (_, i) => ({index: i, embedding: [i, i, i]})),
    model: 'voyage-3-large',
    usage: {total_tokens: 10}
});

const okResponse = (n = 1): Response =>
    new Response(okBody(n), {status: 200, headers: {'Content-Type': 'application/json'}});

const errResponse = (status: number, headers: Record<string, string> = {}): Response =>
    new Response('rate limited', {status, headers});

const make = (opts: Partial<Parameters<typeof VoyageEmbedder.prototype.embed>[0]> = {}) => {
    void opts;
    return new VoyageEmbedder({
        apiKey: 'k',
        model: 'voyage-3-large',
        dimension: 1024,
        retry: {
            baseDelayMs: 1,
            maxDelayMs: 10,
            maxRetries: 4,
            sleep: vi.fn(async () => {}),
            random: () => 0
        }
    });
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('VoyageEmbedder retry', () => {
    it('returns vectors on first success', async () => {
        fetchMock.mockResolvedValueOnce(okResponse(2));
        const embedder = make();
        const vectors = await embedder.embed(['a', 'b'], 'document');
        expect(vectors).toHaveLength(2);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries on 429 then succeeds', async () => {
        fetchMock
            .mockResolvedValueOnce(errResponse(429))
            .mockResolvedValueOnce(okResponse(1));

        const events: number[] = [];
        const embedder = new VoyageEmbedder({
            apiKey: 'k',
            model: 'voyage-3-large',
            retry: {
                baseDelayMs: 1, maxDelayMs: 5, maxRetries: 3,
                sleep: async () => {},
                random: () => 0,
                onRetry: ({attempt}) => events.push(attempt)
            }
        });

        await embedder.embed(['a'], 'document');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(events).toEqual([1]);
    });

    it('retries on 5xx', async () => {
        fetchMock
            .mockResolvedValueOnce(errResponse(503))
            .mockResolvedValueOnce(errResponse(502))
            .mockResolvedValueOnce(okResponse(1));

        await make().embed(['a'], 'document');
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('retries on network error', async () => {
        fetchMock
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(okResponse(1));

        await make().embed(['a'], 'document');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry on 401', async () => {
        fetchMock.mockResolvedValueOnce(errResponse(401));
        await expect(make().embed(['a'], 'document')).rejects.toThrow(/401/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not retry on 400', async () => {
        fetchMock.mockResolvedValueOnce(errResponse(400));
        await expect(make().embed(['a'], 'document')).rejects.toThrow(/400/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('exhausts retries and throws', async () => {
        fetchMock.mockImplementation(() => Promise.resolve(errResponse(429)));
        await expect(make().embed(['a'], 'document')).rejects.toThrow(/429/);
        expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('honors Retry-After header (seconds)', async () => {
        fetchMock
            .mockResolvedValueOnce(errResponse(429, {'Retry-After': '2'}))
            .mockResolvedValueOnce(okResponse(1));

        const waits: number[] = [];
        const embedder = new VoyageEmbedder({
            apiKey: 'k',
            model: 'voyage-3-large',
            retry: {
                baseDelayMs: 1, maxDelayMs: 100_000, maxRetries: 3,
                sleep: async (ms) => { waits.push(ms); },
                random: () => 0
            }
        });

        await embedder.embed(['a'], 'document');
        expect(waits).toEqual([2000]);
    });
});

describe('parseRetryAfter', () => {
    it('parses integer seconds', () => {
        expect(parseRetryAfter('3')).toBe(3000);
    });

    it('parses fractional seconds', () => {
        expect(parseRetryAfter('0.5')).toBe(500);
    });

    it('parses HTTP date relative to now', () => {
        const now = Date.now();
        const future = new Date(now + 4000).toUTCString();
        const ms = parseRetryAfter(future, now);
        expect(ms).not.toBeNull();
        expect(ms!).toBeGreaterThanOrEqual(3000);
        expect(ms!).toBeLessThanOrEqual(5000);
    });

    it('returns null for missing or garbage', () => {
        expect(parseRetryAfter(null)).toBeNull();
        expect(parseRetryAfter('')).toBeNull();
        expect(parseRetryAfter('garbage')).toBeNull();
    });
});