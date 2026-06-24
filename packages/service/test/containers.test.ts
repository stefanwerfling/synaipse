import {describe, expect, it} from 'vitest';
import {stripContainers} from '../src/Containers.js';

describe('stripContainers', () => {
    it('returns input unchanged when no fence present', () => {
        const input = '# Heading\n\nplain paragraph with `code`\n';
        expect(stripContainers(input)).toBe(input);
    });

    it('strips simple ::: infographic fence', () => {
        const input = [
            '::: infographic',
            'Step 1: collect requirements',
            ':::'
        ].join('\n');
        expect(stripContainers(input)).toBe('Step 1: collect requirements');
    });

    it('strips fence with attribute object', () => {
        const input = [
            '::: infographic { icon: "🚀", color: "blue", step: 1 }',
            'Launch the rocket',
            ':::'
        ].join('\n');
        expect(stripContainers(input)).toBe('Launch the rocket');
    });

    it('strips generic types (warning, tip, note)', () => {
        const input = [
            '::: warning',
            'careful here',
            ':::',
            '',
            '::: tip',
            'a small tip',
            ':::'
        ].join('\n');
        expect(stripContainers(input)).toBe([
            'careful here',
            '',
            'a small tip'
        ].join('\n'));
    });

    it('accepts opening without space between colons and type', () => {
        const input = [
            ':::infographic',
            'body',
            ':::'
        ].join('\n');
        expect(stripContainers(input)).toBe('body');
    });

    it('strips multiple sequential containers (roadmap pattern)', () => {
        const input = [
            '# Roadmap',
            '',
            '::: infographic { step: 1 }',
            'Phase A',
            ':::',
            '',
            '::: infographic { step: 2 }',
            'Phase B',
            ':::'
        ].join('\n');
        const out = stripContainers(input);
        expect(out).toContain('Phase A');
        expect(out).toContain('Phase B');
        expect(out).not.toContain(':::');
        expect(out).not.toContain('step:');
    });

    it('preserves :::-like text mid-line', () => {
        const input = 'before ::: in the middle of a sentence';
        expect(stripContainers(input)).toBe(input);
    });

    it('preserves fences with 4+ colons', () => {
        const input = [
            ':::: not a container',
            'body',
            '::::'
        ].join('\n');
        expect(stripContainers(input)).toBe(input);
    });

    it('strips unclosed opening, leaves body intact', () => {
        const input = [
            '::: infographic',
            'orphaned body without close'
        ].join('\n');
        expect(stripContainers(input)).toBe('orphaned body without close');
    });

    it('is idempotent', () => {
        const input = [
            '::: infographic',
            'content',
            ':::'
        ].join('\n');
        const once = stripContainers(input);
        const twice = stripContainers(once);
        expect(twice).toBe(once);
    });

    it('rejects non-letter type starts (numeric, punctuation)', () => {
        const input = [
            '::: 1step',
            'body',
            ':::'
        ].join('\n');
        // opening fails to match (type must start with letter), close still matches
        const out = stripContainers(input);
        expect(out).toContain('::: 1step');
        expect(out).toContain('body');
        expect(out).not.toMatch(/^:::$/m);
    });
});
