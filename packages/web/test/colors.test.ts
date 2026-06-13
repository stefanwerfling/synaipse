import {describe, it, expect} from 'vitest';
import {colorForNode, hashString, tagColor, NEUTRAL_COLOR} from '../src/Colors.js';

describe('colors', () => {
    it('hashString is stable across calls', () => {
        expect(hashString('foo')).toBe(hashString('foo'));
        expect(hashString('foo')).not.toBe(hashString('bar'));
    });

    it('tagColor returns hsl string with valid hue range', () => {
        const tags = ['adr', 'architecture', 'typescript', 'docker', 'embeddings'];

        for (const tag of tags) {
            const color = tagColor(tag);
            const m = /^hsl\((\d+(?:\.\d+)?), 60%, 58%\)$/.exec(color);
            expect(m, `unexpected color shape: ${color}`).not.toBeNull();

            const hue = Number.parseFloat(m![1]!);
            expect(hue).toBeGreaterThanOrEqual(0);
            expect(hue).toBeLessThan(360);
        }
    });

    it('tagColor is deterministic for same tag', () => {
        expect(tagColor('typescript')).toBe(tagColor('typescript'));
    });

    it('colorForNode uses first tag', () => {
        expect(colorForNode(['adr', 'architecture'])).toBe(tagColor('adr'));
    });

    it('colorForNode falls back to neutral for empty tags', () => {
        expect(colorForNode([])).toBe(NEUTRAL_COLOR);
    });
});