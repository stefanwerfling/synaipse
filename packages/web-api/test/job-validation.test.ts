import {describe, it, expect} from 'vitest';
import {ALLOWED_JOB_TYPES, isJobType, validateJobParams} from '../server/job-validation.js';

describe('isJobType', () => {
    it('accepts every allowed type and nothing else', () => {
        for (const t of ALLOWED_JOB_TYPES) expect(isJobType(t)).toBe(true);
        expect(isJobType('nope')).toBe(false);
        expect(isJobType(undefined)).toBe(false);
        expect(isJobType(42)).toBe(false);
    });

    it('covers the three new crawler providers', () => {
        expect(ALLOWED_JOB_TYPES).toContain('crawl-devto');
        expect(ALLOWED_JOB_TYPES).toContain('crawl-github-stars');
        expect(ALLOWED_JOB_TYPES).toContain('crawl-code');
    });
});

describe('validateJobParams', () => {
    it('requires prefix (as a string) for relink/compile', () => {
        expect(validateJobParams('relink', {prefix: ''})).toBeNull();
        expect(validateJobParams('compile', {prefix: 'Crawler/'})).toBeNull();
        expect(validateJobParams('relink', {})).toMatch(/prefix/);
        expect(validateJobParams('relink', {prefix: 3})).toMatch(/prefix/);
    });

    it('requires the four gitea fields', () => {
        const ok = {baseUrl: 'https://g', owner: 'o', repo: 'r', project: 'p'};
        expect(validateJobParams('crawl-gitea', ok)).toBeNull();
        expect(validateJobParams('crawl-gitea', {...ok, repo: ''})).toMatch(/repo/);
        expect(validateJobParams('crawl-gitea', {baseUrl: 'x'})).toMatch(/owner/);
    });

    it('requires repoPath for the code crawler', () => {
        expect(validateJobParams('crawl-code', {repoPath: '/tmp/repo'})).toBeNull();
        expect(validateJobParams('crawl-code', {repoPath: '  '})).toMatch(/repoPath/);
        expect(validateJobParams('crawl-code', {})).toMatch(/repoPath/);
    });

    it('treats every field as optional for devto/github-stars (secrets from env)', () => {
        expect(validateJobParams('crawl-devto', {})).toBeNull();
        expect(validateJobParams('crawl-github-stars', {})).toBeNull();
        expect(validateJobParams('crawl-devto', {perPage: 50})).toBeNull();
    });
});
