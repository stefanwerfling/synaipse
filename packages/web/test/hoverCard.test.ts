import {describe, it, expect} from 'vitest';
import {clipSnippet, positionHoverCard} from '../src/HoverCard.js';

const viewport = {width: 1000, height: 800};
const constraints = {cardWidth: 320, cardMaxHeight: 200, margin: 8};

describe('positionHoverCard', () => {
    it('places card below the anchor by default', () => {
        const {left, top} = positionHoverCard(
            {left: 100, top: 100, bottom: 120},
            viewport,
            constraints
        );
        expect(left).toBe(100);
        expect(top).toBe(128);
    });

    it('clamps left when anchor is near right edge', () => {
        const {left} = positionHoverCard(
            {left: 900, top: 100, bottom: 120},
            viewport,
            constraints
        );
        expect(left).toBe(viewport.width - constraints.cardWidth - constraints.margin!);
    });

    it('clamps left when anchor is near left edge', () => {
        const {left} = positionHoverCard(
            {left: -50, top: 100, bottom: 120},
            viewport,
            constraints
        );
        expect(left).toBe(constraints.margin);
    });

    it('flips above when there is no space below', () => {
        const {top} = positionHoverCard(
            {left: 100, top: 700, bottom: 720},
            viewport,
            constraints
        );
        expect(top).toBe(700 - constraints.cardMaxHeight - constraints.margin!);
    });

    it('clamps within viewport when both placements would clip', () => {
        const {top} = positionHoverCard(
            {left: 100, top: 100, bottom: 700},
            {width: 1000, height: 750},
            constraints
        );
        // No room above (anchor.top 100 < cardMaxHeight 200 + margin 8) and no room
        // below (700 + 8 + 200 > 750 - 8) → clamp so card.bottom == viewport - margin
        expect(top).toBe(750 - constraints.cardMaxHeight - constraints.margin!);
    });
});

describe('clipSnippet', () => {
    it('strips frontmatter, code fences, headings, wikilinks', () => {
        const md = [
            '---',
            'title: Foo',
            '---',
            '',
            '# Heading',
            '',
            'See [[Other Note|the other]] for details.',
            '',
            '```ts',
            'const x = 1;',
            '```',
            'inline `code` here.'
        ].join('\n');

        const result = clipSnippet(md, 1000);
        expect(result).not.toContain('---');
        expect(result).not.toContain('# Heading');
        expect(result).not.toContain('[[');
        expect(result).toContain('the other');
        expect(result).toContain('⟨code⟩');
        expect(result).toContain('code');
    });

    it('truncates with ellipsis when exceeding maxChars', () => {
        const result = clipSnippet('a'.repeat(500), 100);
        expect(result.length).toBeLessThanOrEqual(101);
        expect(result.endsWith('…')).toBe(true);
    });

    it('leaves shorter snippets unmodified', () => {
        expect(clipSnippet('short body', 100)).toBe('short body');
    });
});