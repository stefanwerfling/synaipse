import {describe, it, expect} from 'vitest';
import {colorForNode, contrastRatio, hashString, hslToRgb, tagColor, tagTextColor, NEUTRAL_COLOR} from '../src/Colors.js';

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
describe('readable tag text (WCAG AA)', () => {
    const rgb = (hsl: string): number[] => {
        const m = /hsl\((\d+), 60%, (\d+)%\)/.exec(hsl);
        if (m === null) throw new Error(hsl);
        return hslToRgb(Number(m[1]), 60, Number(m[2]));
    };

    it('reaches 4.5:1 for every hue on the selected row of each theme, keeping the hue', () => {
        for (let i = 0; i < 400; i++) {
            const tag = `tag-${i}`;
            const hue = /hsl\((\d+)/.exec(tagColor(tag))![1];
            const dark = tagTextColor(tag, 'dark');
            const light = tagTextColor(tag, 'light');
            expect(dark.startsWith(`hsl(${hue},`)).toBe(true);
            expect(light.startsWith(`hsl(${hue},`)).toBe(true);
            expect(contrastRatio(rgb(dark), [0x20, 0x29, 0x3d])).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(rgb(dark), [0x0b, 0x0d, 0x12])).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(rgb(light), [0xd7, 0xdf, 0xef])).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(rgb(light), [0xff, 0xff, 0xff])).toBeGreaterThanOrEqual(4.5);
            // as a chip fill: dark text in the dark theme, white text in the light one
            expect(contrastRatio(rgb(dark), [0x0f, 0x11, 0x15])).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(rgb(light), [0xff, 0xff, 0xff])).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('hslToRgb and contrastRatio match known values', () => {
        expect(hslToRgb(0, 100, 50)).toEqual([255, 0, 0]);
        expect(hslToRgb(120, 100, 25)).toEqual([0, 128, 0]);
        expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
        expect(contrastRatio([0x6b, 0x72, 0x80], [0x11, 0x14, 0x1a])).toBeCloseTo(3.81, 2);
    });
});
