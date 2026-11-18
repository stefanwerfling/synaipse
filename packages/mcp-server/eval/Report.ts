import type {EvalCategory} from './fixture.js';

/** Result types and the regression rule of the LLM eval (plan P8 / B7). */

export interface QuestionResult {
    id: string;
    category: EvalCategory;
    /** 1-based rank of the best relevant note, 0 = not in the hits. */
    rank: number;
    recallAt5: number;
    /** An outdated note ranks above the best relevant one (or shows while it is missing). */
    outdatedAbove: boolean;
    searchTokens: number;
    readTokens: number;
}

export interface Summary {
    questions: number;
    hitAt1: number;
    recallAt5: number;
    mrr: number;
    /** Share of questions with outdated notes where one ranked above the answer. */
    outdatedAbove: number;
    tokensPerQuestion: number;
}

export interface EvalReport {
    fixture: {notes: number; questions: number};
    context: {toolListTokens: number; instructionsTokens: number; primeTokens: number};
    overall: Summary;
    byCategory: Record<string, Summary>;
    questions: QuestionResult[];
}

/** Differences that count as a regression against the baseline (empty = ok). */
export const regressions = (base: EvalReport, now: EvalReport): string[] => {
    const out: string[] = [];
    const lower = (name: string, b: number, c: number): void => {
        if (c < b - 1e-9) out.push(`${name}: ${b} → ${c}`);
    };
    const higher = (name: string, b: number, c: number, slack: number): void => {
        if (c > b * (1 + slack) + 1e-9) out.push(`${name}: ${b} → ${c}`);
    };

    lower('hit@1', base.overall.hitAt1, now.overall.hitAt1);
    lower('recall@5', base.overall.recallAt5, now.overall.recallAt5);
    lower('mrr', base.overall.mrr, now.overall.mrr);
    higher('outdatedAbove', base.overall.outdatedAbove, now.overall.outdatedAbove, 0);
    higher('tokensPerQuestion', base.overall.tokensPerQuestion, now.overall.tokensPerQuestion, 0.05);
    higher('toolListTokens', base.context.toolListTokens, now.context.toolListTokens, 0.05);
    higher('instructionsTokens', base.context.instructionsTokens, now.context.instructionsTokens, 0.05);
    higher('primeTokens', base.context.primeTokens, now.context.primeTokens, 0.05);
    return out;
};
