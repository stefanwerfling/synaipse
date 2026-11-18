import {defineConfig} from 'vitest/config';

/** LLM-usability eval (plan P8 / B7): `npm run eval`, see packages/mcp-server/eval/llm.eval.ts. */
export default defineConfig({
    test: {
        include: ['packages/*/eval/**/*.eval.ts'],
        environment: 'node',
        clearMocks: true,
        passWithNoTests: false,
        testTimeout: 120000
    }
});
