import {describe, expect, it} from 'vitest';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {gunzipSync} from 'node:zlib';
import {intParam, jsonCached} from '../server/cached-json.js';

interface Captured {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
}

const request = (headers: Record<string, string> = {}): IncomingMessage => ({headers} as unknown as IncomingMessage);

const response = (): {res: ServerResponse; out: Captured} => {
    const out: Captured = {status: 0, headers: {}, body: Buffer.alloc(0)};
    const res = {
        writeHead(status: number, headers: Record<string, string>) {
            out.status = status;
            out.headers = headers;
            return this;
        },
        end(chunk?: Buffer) {
            out.body = chunk ?? Buffer.alloc(0);
            return this;
        }
    } as unknown as ServerResponse;
    return {res, out};
};

const big = {nodes: Array.from({length: 2000}, (_, i) => ({id: `n${i}`, title: `Note ${i}`}))};

describe('jsonCached', () => {
    it('sends an ETag and answers a matching If-None-Match with 304', async () => {
        const first = response();
        await jsonCached(request(), first.res, {a: 1});
        expect(first.out.status).toBe(200);
        expect(first.out.headers.ETag).toMatch(/^"[0-9a-f]{40}"$/);
        expect(first.out.headers['Cache-Control']).toBe('no-cache');

        const second = response();
        const body = {a: 1};
        await jsonCached(request({'if-none-match': first.out.headers.ETag!}), second.res, body);
        expect(second.out.status).toBe(304);
        expect(second.out.body.length).toBe(0);

        const weak = response();
        await jsonCached(request({'if-none-match': `W/${first.out.headers.ETag!}`}), weak.res, body);
        expect(weak.out.status).toBe(304);
    });

    it('uses the given seed as ETag and gzips large bodies once per object', async () => {
        const a = response();
        await jsonCached(request({'accept-encoding': 'gzip, br'}), a.res, big, 'layout-hash');
        expect(a.out.headers.ETag).toBe('"layout-hash"');
        expect(a.out.headers['Content-Encoding']).toBe('gzip');
        expect(JSON.parse(gunzipSync(a.out.body).toString('utf8'))).toEqual(big);

        const b = response();
        await jsonCached(request({'accept-encoding': 'gzip'}), b.res, big, 'ignored-now');
        expect(b.out.body).toBe(a.out.body);
        expect(b.out.headers.ETag).toBe('"layout-hash"');
    });

    it('sends plain JSON to clients without gzip', async () => {
        const {res, out} = response();
        await jsonCached(request(), res, big);
        expect(out.headers['Content-Encoding']).toBeUndefined();
        expect(JSON.parse(out.body.toString('utf8'))).toEqual(big);
    });
});

describe('intParam', () => {
    const url = (q: string): URL => new URL(`http://x/api?${q}`);

    it('falls back on missing or garbage input and clamps', () => {
        expect(intParam(url(''), 'limit', 20, 1, 200)).toBe(20);
        expect(intParam(url('limit=abc'), 'limit', 20, 1, 200)).toBe(20);
        expect(intParam(url('limit=0'), 'limit', 20, 1, 200)).toBe(1);
        expect(intParam(url('limit=99999'), 'limit', 20, 1, 200)).toBe(200);
        expect(intParam(url('limit=42'), 'limit', 20, 1, 200)).toBe(42);
    });
});
