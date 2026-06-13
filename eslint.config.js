import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: [
            '**/dist/**',
            '**/node_modules/**',
            '**/*.tsbuildinfo',
            'packages/web/dist/web/**'
        ]
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module'
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_'
            }],
            '@typescript-eslint/no-explicit-any': 'warn',
            'no-console': ['warn', {allow: ['warn', 'error']}],
            'eqeqeq': ['error', 'always'],
            'prefer-const': 'error',
            'no-var': 'error',
            'no-empty': ['error', {allowEmptyCatch: true}]
        }
    },
    {
        files: ['**/test/**/*.ts', '**/*.test.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off'
        }
    }
);