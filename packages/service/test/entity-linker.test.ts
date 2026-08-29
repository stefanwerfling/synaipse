import {describe, it, expect} from 'vitest';
import {extractEntitySpans} from '../src/EntityLinker.js';

describe('extractEntitySpans', () => {
    it('picks up capitalized tech/product names alongside classic proper nouns', () => {
        const spans = extractEntitySpans(
            'We evaluated Neo4j and Qdrant for the Graph3D feature. Stefan discussed GraphRAG with the team.'
        );

        expect(spans).toContain('Neo4j');
        expect(spans).toContain('Qdrant');
        expect(spans).toContain('Graph3D');
        expect(spans).toContain('Stefan');
        expect(spans).toContain('GraphRAG');
    });

    it('picks up acronyms', () => {
        const spans = extractEntitySpans('The team compared NER approaches against an LLM baseline.');
        expect(spans).toContain('NER');
        expect(spans).toContain('LLM');
    });

    it('drops spans shorter than the minimum length', () => {
        const spans = extractEntitySpans('It is a A B test.');
        expect(spans.every((s) => s.length >= 3)).toBe(true);
    });

    it('returns no spans for lowercase-only text', () => {
        const spans = extractEntitySpans('this is a plain lowercase sentence with no proper nouns');
        expect(spans).toEqual([]);
    });
});
