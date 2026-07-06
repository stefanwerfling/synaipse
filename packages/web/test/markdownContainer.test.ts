import {beforeAll, describe, expect, it} from 'vitest';
import {Marked} from 'marked';
import {setupContainerExtension} from '../src/MarkdownContainer.js';

// Use a fresh Marked instance per file so the install-once guard in
// setupContainerExtension doesn't interfere across test files. setup is
// idempotent on the *namespace*, but we want isolated parsing here.
const md = new Marked();

beforeAll(() => {
    setupContainerExtension(md as unknown as typeof import('marked').marked);
});

const render = (src: string): string => md.parse(src, {async: false, gfm: true}) as string;

describe('container extension', () => {
    it('renders a plain ::: infographic block as a card', () => {
        const html = render('::: infographic\nPhase Alpha\n:::');

        expect(html).toContain('class="md-container md-container-infographic"');
        expect(html).toContain('md-container-body');
        expect(html).toContain('Phase Alpha');
    });

    it('parses inner markdown (heading, list) recursively', () => {
        const html = render([
            '::: infographic',
            '## Step',
            '',
            '- a',
            '- b',
            ':::'
        ].join('\n'));

        expect(html).toContain('<h2');
        expect(html).toContain('<ul>');
        expect(html).toContain('<li>a</li>');
    });

    it('renders attrs: icon, color allowlisted, step', () => {
        const html = render('::: infographic { icon: "🚀", color: "blue", step: 1 }\nBody\n:::');

        expect(html).toContain('md-container-color-blue');
        expect(html).toContain('md-container-step');
        expect(html).toContain('>1<');
        expect(html).toContain('md-container-icon');
        expect(html).toContain('🚀');
    });

    it('drops non-allowlisted color values', () => {
        const html = render('::: warning { color: "javascript:alert(1)" }\nBody\n:::');

        expect(html).not.toContain('md-container-color-');
        expect(html).not.toContain('javascript');
    });

    it('renders an optional title after the type', () => {
        const html = render('::: warning Mind the gap\nbody\n:::');

        expect(html).toContain('md-container-title');
        expect(html).toContain('Mind the gap');
    });

    it('escapes HTML in title and icon', () => {
        const html = render('::: warning { icon: "<img onerror=x>" } <script>alert(1)</script>\nbody\n:::');

        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<img onerror');
        expect(html).toContain('&lt;script&gt;');
    });

    it('omits header div when no header parts are present', () => {
        const html = render('::: tip\nbody\n:::');

        expect(html).not.toContain('md-container-header');
        expect(html).toContain('md-container-body');
    });

    it('renders multiple sequential containers (roadmap)', () => {
        const html = render([
            '::: infographic { step: 1 }',
            'Phase A',
            ':::',
            '',
            '::: infographic { step: 2 }',
            'Phase B',
            ':::'
        ].join('\n'));

        expect(html.match(/md-container-infographic/g) ?? []).toHaveLength(2);
        expect(html).toContain('>1<');
        expect(html).toContain('>2<');
        expect(html).toContain('Phase A');
        expect(html).toContain('Phase B');
    });

    it('falls through to normal markdown when fence is malformed (no close)', () => {
        const html = render('::: infographic\nunclosed body');

        expect(html).not.toContain('md-container');
        expect(html).toContain('unclosed body');
    });

    it('accepts no-space-after-colons opening', () => {
        const html = render(':::infographic\nbody\n:::');
        expect(html).toContain('md-container-infographic');
    });

    it('handles generic types (warning, tip, note) — class reflects type', () => {
        expect(render('::: warning\nx\n:::')).toContain('md-container-warning');
        expect(render('::: tip\nx\n:::')).toContain('md-container-tip');
        expect(render('::: note\nx\n:::')).toContain('md-container-note');
    });

    describe('antv layout-name branch', () => {
        const antvSrc = [
            '::: infographic list-row-horizontal-icon-arrow',
            'data',
            '  title Customer Growth Engine',
            '  desc Multi-channel reach',
            '  lists',
            '    - label Lead Acquisition',
            '      value 18.6',
            ':::'
        ].join('\n');

        it('routes to the antv branch when second token is a hyphenated layout name', () => {
            const html = render(antvSrc);
            expect(html).toContain('md-antv-infographic');
            expect(html).toContain('data-infographic-layout="list-row-horizontal-icon-arrow"');
            expect(html).not.toContain('md-container-body'); // antv branch skips the card chrome
        });

        it('preserves the body verbatim in the data-infographic-syntax attribute', () => {
            const html = render(antvSrc);
            // data-infographic-syntax is a JSON-encoded string; we just check
            // that the original body lines survived the encoding round-trip.
            expect(html).toContain('Customer Growth Engine');
            expect(html).toContain('Lead Acquisition');
            expect(html).toContain('18.6');
        });

        it('still uses the card branch when the second token is { attrs }', () => {
            const html = render('::: infographic { icon: "🚀", step: 1 }\nBody\n:::');
            expect(html).toContain('md-container-infographic');
            expect(html).not.toContain('md-antv-infographic');
        });

        it('still uses the card branch for non-infographic types with a bare layout-like name', () => {
            // `::: tip list-row` — layout names are only consumed when type
            // is `infographic`. Other types keep the text as headerTitle.
            const html = render('::: tip list-row\nbody\n:::');
            expect(html).toContain('md-container-tip');
            expect(html).not.toContain('md-antv-infographic');
        });
    });

    describe('floorplan branch', () => {
        const floorSrc = [
            '::: floorplan',
            '@title Kleine Wohnung',
            '@scale 55',
            'room Küche 0,0 4x3',
            '  door N 1 1',
            '  power 0.5,2.5 label=Kühlschrank',
            ':::'
        ].join('\n');

        it('emits an md-floorplan stub for ::: floorplan blocks', () => {
            const html = render(floorSrc);
            expect(html).toContain('class="md-floorplan"');
            expect(html).toContain('data-floorplan-syntax=');
            // The card body of the plain-container branch must be skipped.
            expect(html).not.toContain('md-container-body');
        });

        it('preserves the DSL body verbatim in data-floorplan-syntax', () => {
            const html = render(floorSrc);
            // data-floorplan-syntax is JSON-encoded and then HTML-escaped.
            // JSON.stringify leaves non-ASCII UTF-8 alone; only `"`, `\`,
            // control chars and newlines are escaped. Newlines become `\n`.
            expect(html).toContain('@title Kleine Wohnung');
            expect(html).toContain('room Küche 0,0 4x3');
            expect(html).toContain('  door N 1 1');
            expect(html).toContain('label=Kühlschrank');
        });

        it('does not disturb unrelated container types', () => {
            const html = render('::: warning\nbe careful\n:::');
            expect(html).toContain('md-container-warning');
            expect(html).not.toContain('md-floorplan');
        });
    });
});