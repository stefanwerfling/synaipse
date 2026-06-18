import {defineConfig} from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/*/benchmark/**/*.bench.ts'],
        environment: 'node',
        clearMocks: true,
        passWithNoTests: false,
        testTimeout: 60000
    }
});