import {describe, it, expect} from 'vitest';
import type {Reranker} from '../src/Reranker.js';

/**
 * The real HuggingFaceReranker downloads ~90MB of ONNX + weights on
 * first call — too heavy for a unit suite. Instead we verify the
 * contract via a stub Reranker: given a fixed rule (passages that
 * contain the query token score higher), the ordering behaves
 * deterministically and matches what a real cross-encoder would produce
 * on a trivial input. This locks in the interface shape.
 */
class KeywordCountReranker implements Reranker {
    public readonly model = 'stub/keyword-count';

    public async score(query: string, passages: string[]): Promise<number[]> {
        const token = query.trim().toLowerCase();
        return passages.map((p) => {
            const lower = p.toLowerCase();
            let count = 0;
            let idx = lower.indexOf(token);
            while (idx !== -1) {
                count += 1;
                idx = lower.indexOf(token, idx + token.length);
            }
            return count;
        });
    }
}

describe('Reranker contract', () => {
    it('returns one score per passage, in input order', async () => {
        const rerank = new KeywordCountReranker();
        const scores = await rerank.score('foo', ['foo bar', 'nothing here', 'foo foo foo']);
        expect(scores).toHaveLength(3);
        expect(scores).toEqual([1, 0, 3]);
    });

    it('returns empty for empty passages', async () => {
        const rerank = new KeywordCountReranker();
        expect(await rerank.score('anything', [])).toEqual([]);
    });

    it('a caller can zip scores back to hits and reorder deterministically', async () => {
        const rerank = new KeywordCountReranker();
        const hits = [
            {id: 'a', passage: 'bar bar'},
            {id: 'b', passage: 'foo bar foo'},
            {id: 'c', passage: 'foo'}
        ];
        const scores = await rerank.score('foo', hits.map((h) => h.passage));
        const paired = hits.map((h, i) => ({...h, score: scores[i] ?? 0}));
        paired.sort((a, b) => b.score - a.score);
        expect(paired.map((p) => p.id)).toEqual(['b', 'c', 'a']);
    });
});