import {describe, it, expect} from 'vitest';
import {validateFrontmatter, NOTE_TYPES} from '../src/Index.js';

describe('validateFrontmatter', () => {
    it('accepts empty frontmatter', () => {
        const result = validateFrontmatter({});
        expect(result.ok).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('accepts all known fields', () => {
        const result = validateFrontmatter({
            title: 'My Decision',
            tags: ['decision', 'adr'],
            aliases: ['BackendCluster v1'],
            created: '2026-06-13',
            updated: '2026-06-13',
            type: 'decision',
            why: 'BackendApp became too large',
            confidence: 0.9,
            sources: ['[[ADR-023]]', 'commit:abc123'],
            supersedes: ['BackendCluster v1']
        });
        expect(result.ok).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('ignores unknown frontmatter keys (open schema)', () => {
        const result = validateFrontmatter({
            title: 'X',
            custom_key: 'some value',
            nested: {a: 1}
        });
        expect(result.ok).toBe(true);
    });

    it('rejects an invalid note type', () => {
        const result = validateFrontmatter({type: 'meeting'});
        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toMatch(/type/);
    });

    it('rejects confidence outside [0, 1]', () => {
        const tooHigh = validateFrontmatter({confidence: 1.5});
        expect(tooHigh.ok).toBe(false);
        expect(tooHigh.errors.join(' ')).toMatch(/confidence/);

        const negative = validateFrontmatter({confidence: -0.1});
        expect(negative.ok).toBe(false);
    });

    it('accepts confidence at boundaries', () => {
        expect(validateFrontmatter({confidence: 0}).ok).toBe(true);
        expect(validateFrontmatter({confidence: 1}).ok).toBe(true);
    });

    it('rejects wrong types for known fields', () => {
        const result = validateFrontmatter({tags: 'not-an-array'});
        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toMatch(/tags/);
    });

    it('accepts every documented note type', () => {
        for (const type of NOTE_TYPES) {
            expect(validateFrontmatter({type}).ok).toBe(true);
        }
    });
});