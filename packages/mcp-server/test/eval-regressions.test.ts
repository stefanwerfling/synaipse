import {describe, expect, it} from 'vitest';
import {regressions, type EvalReport} from '../eval/Report.js';

const report = (over: Partial<EvalReport['overall']> = {}, context: Partial<EvalReport['context']> = {}): EvalReport => ({
    fixture: {notes: 1, questions: 1},
    context: {toolListTokens: 1000, instructionsTokens: 200, primeTokens: 800, ...context},
    overall: {questions: 10, hitAt1: 0.6, recallAt5: 0.9, mrr: 0.7, outdatedAbove: 0.4, tokensPerQuestion: 500, ...over},
    byCategory: {},
    questions: []
});

describe('eval regressions', () => {
    it('accepts equal or better results', () => {
        expect(regressions(report(), report())).toEqual([]);
        expect(regressions(report(), report({hitAt1: 0.8, outdatedAbove: 0.1, tokensPerQuestion: 400}, {toolListTokens: 900}))).toEqual([]);
    });

    it('flags lower quality and more outdated answers', () => {
        expect(regressions(report(), report({hitAt1: 0.5, mrr: 0.69, outdatedAbove: 0.5}))).toEqual([
            'hit@1: 0.6 → 0.5', 'mrr: 0.7 → 0.69', 'outdatedAbove: 0.4 → 0.5'
        ]);
    });

    it('allows 5 % more tokens, not more', () => {
        expect(regressions(report(), report({tokensPerQuestion: 525}, {primeTokens: 840}))).toEqual([]);
        expect(regressions(report(), report({tokensPerQuestion: 526}, {toolListTokens: 1051}))).toEqual([
            'tokensPerQuestion: 500 → 526', 'toolListTokens: 1000 → 1051'
        ]);
    });
});
