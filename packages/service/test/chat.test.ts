import {describe, it, expect} from 'vitest';
import type {SearchHit} from '@synaipse/core';
import {runChat, type ChatEvent} from '../src/Chat.js';

const hit = (id: string, title: string, score: number, snippet?: string): SearchHit => ({
    noteId: id,
    path: id,
    title,
    score,
    ...(snippet !== undefined ? {snippet} : {})
});

const collect = async (gen: AsyncGenerator<ChatEvent, void, void>): Promise<ChatEvent[]> => {
    const out: ChatEvent[] = [];
    for await (const e of gen) {
        out.push(e);
    }
    return out;
};

const streamFetch = (lines: string[]): typeof fetch => {
    return (async (): Promise<Response> => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const line of lines) {
                    controller.enqueue(encoder.encode(line));
                }
                controller.close();
            }
        });

        return new Response(stream, {
            status: 200,
            headers: {'content-type': 'application/x-ndjson'}
        });
    }) as typeof fetch;
};

describe('runChat', () => {
    it('emits start with sources, streams tokens, then done', async () => {
        const hits = [
            hit('Memory/a.md', 'Note A', 0.9, 'snippet A'),
            hit('Memory/b.md', 'Note B', 0.7, 'snippet B')
        ];

        const fakeFetch = streamFetch([
            JSON.stringify({message: {role: 'assistant', content: 'Hello '}}) + '\n',
            JSON.stringify({message: {role: 'assistant', content: 'world'}}) + '\n',
            JSON.stringify({done: true, eval_count: 12}) + '\n'
        ]);

        const events = await collect(runChat({
            search: async () => hits,
            readNote: () => undefined,
            provider: {url: 'http://x', model: 'gemma3:4b', fetch: fakeFetch}
        }, {question: 'what?'}));

        expect(events[0]?.kind).toBe('start');
        const start = events[0] as Extract<ChatEvent, {kind: 'start'}>;
        expect(start.sources.length).toBe(2);
        expect(start.sources[0]?.index).toBe(1);
        expect(start.sources[0]?.title).toBe('Note A');
        expect(start.model).toBe('gemma3:4b');

        const tokens = events.filter((e) => e.kind === 'token') as Extract<ChatEvent, {kind: 'token'}>[];
        expect(tokens.map((t) => t.text).join('')).toBe('Hello world');

        const done = events[events.length - 1];
        expect(done?.kind).toBe('done');
        if (done?.kind === 'done') {
            expect(done.totalTokens).toBe(12);
        }
    });

    it('falls back to readNote when search hits have no snippet', async () => {
        const hits = [hit('Memory/foo.md', 'Foo', 0.5)];

        const reads: string[] = [];

        const fakeFetch = streamFetch([
            JSON.stringify({done: true, eval_count: 0}) + '\n'
        ]);

        const events = await collect(runChat({
            search: async () => hits,
            readNote: (id) => {
                reads.push(id);
                return '---\ntitle: Foo\n---\nThis is the body.';
            },
            provider: {url: 'http://x', model: 'm', fetch: fakeFetch}
        }, {question: 'q'}));

        expect(reads).toEqual(['Memory/foo.md']);
        const start = events[0] as Extract<ChatEvent, {kind: 'start'}>;
        expect(start.sources[0]?.snippet).toBe('This is the body.');
    });

    it('emits error event when ollama fails', async () => {
        const failFetch = (async () => new Response('boom', {status: 500})) as typeof fetch;

        const events = await collect(runChat({
            search: async () => [hit('a.md', 'A', 1)],
            readNote: () => undefined,
            provider: {url: 'http://x', model: 'm', fetch: failFetch}
        }, {question: 'q'}));

        const last = events[events.length - 1];
        expect(last?.kind).toBe('error');
    });

    it('handles partial JSON chunks across stream boundaries', async () => {
        const full = JSON.stringify({message: {role: 'assistant', content: 'concat'}});
        const split1 = full.slice(0, 10);
        const split2 = full.slice(10) + '\n' + JSON.stringify({done: true}) + '\n';

        const fakeFetch = streamFetch([split1, split2]);

        const events = await collect(runChat({
            search: async () => [],
            readNote: () => undefined,
            provider: {url: 'http://x', model: 'm', fetch: fakeFetch}
        }, {question: 'q'}));

        const tokens = events.filter((e) => e.kind === 'token') as Extract<ChatEvent, {kind: 'token'}>[];
        expect(tokens.map((t) => t.text).join('')).toBe('concat');
    });
});