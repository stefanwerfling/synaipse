import {describe, expect, it} from 'vitest';
import {renderRelatedSection, sanitizeReason} from '../src/Relink.js';
import type {AcceptedLink} from '../src/Relink.js';

/**
 * Regression coverage for the `## Related` block generator. The function
 * embeds a reason snippet pulled from another note's body into a markdown
 * list item, and pre-sanitize it routinely broke the host document — see
 * 68dafab. These tests pin the sanitizer behaviour and verify that the
 * full rendered block stays well-formed for the kinds of snippets we
 * actually see in the swipemeister vault.
 */

const link = (overrides: Partial<AcceptedLink> & {title: string; reason: string}): AcceptedLink => ({
    noteId: overrides.title,
    score: 0.05,
    ...overrides
});

describe('sanitizeReason', () => {
    it('collapses whitespace + trims', () => {
        expect(sanitizeReason('  multi\n\nline   reason\twith\ttabs ')).toBe('multi line reason with tabs');
    });

    it('replaces triple backticks so they cannot open a code fence', () => {
        // This is the literal bug from 68dafab — a triple-backtick from a
        // snippet would open a fence that ate every subsequent list item.
        const cleaned = sanitizeReason('see ```dart\nfinal x = ...');
        expect(cleaned).not.toContain('```');
        expect(cleaned).toContain("'''");
    });

    it('replaces single backticks with safe lookalikes', () => {
        expect(sanitizeReason('uses `app/lib/main.dart` directly')).not.toContain('`');
    });

    it('neutralises [[wikilinks]] so they do not mint unwanted backlinks', () => {
        const cleaned = sanitizeReason('Details in [[Backend Setup Hooks & Scheduling]].');
        expect(cleaned).not.toContain('[[');
        expect(cleaned).not.toContain(']]');
    });

    it('strips a leading heading marker', () => {
        expect(sanitizeReason('# Google OAuth — HMAC-Signed State')).toBe('Google OAuth — HMAC-Signed State');
    });

    it('strips a leading list marker', () => {
        expect(sanitizeReason('- nested item from another list')).toBe('nested item from another list');
        expect(sanitizeReason('* asterisk style')).toBe('asterisk style');
        expect(sanitizeReason('+ plus style')).toBe('plus style');
    });

    it('strips a leading blockquote marker', () => {
        expect(sanitizeReason('> quoted prefix')).toBe('quoted prefix');
    });

    it('replaces pipes so the list item is not mistaken for a table row', () => {
        const cleaned = sanitizeReason('| `ApiException.dart` | Thin wrapper |');
        expect(cleaned).not.toContain('|');
    });

    it('clips at 140 characters', () => {
        const long = 'a'.repeat(200);
        expect(sanitizeReason(long).length).toBe(140);
    });

    it('returns empty string for whitespace-only input', () => {
        expect(sanitizeReason('   \n\t  ')).toBe('');
    });

    // ---- Real-world reproducers pulled verbatim from broken swipemeister
    // notes. These six snippets are the exact reasons that previously
    // smuggled code fences and headings into `## Related` blocks. The
    // assertions are deliberately about *output well-formedness*, not the
    // specific replacement chosen, so future tightening (e.g. unicode
    // brackets vs. some other neutral marker) remains free.

    const reproducers: Array<{name: string; raw: string}> = [
        {
            name: 'triple backtick fence opener',
            raw: '# FigTree — HTTP Server & Routes\n\n`src/Server/HttpServer/` — Express-5 basierter HTTP/HTTPS-Server.\n\n## Hierarchie\n\n```\nBaseHttpServer  (TLS'
        },
        {
            name: 'table-row with pipes and backticks',
            raw: '| `ApiException.dart` | Thin wrapper carrying `statusCode` + message; surfaced by pages for error toasts |\n\n## Domain clients (one per `/v1/'
        },
        {
            name: 'leading heading + newlines',
            raw: '# Google OAuth — HMAC-Signed State, No Session\n\nThe Flutter app never talks to Google directly. Everything goes\nthrough the backend so the O'
        },
        {
            name: 'embedded [[wikilink]]',
            raw: '()`):\n   - `materializeRecurring.run()` every 24h\n   - `autoSyncProviders.run()` every 1h\n\nDetails in [[Backend Setup Hooks & Scheduling]].'
        },
        {
            name: 'shell command with backticks across lines',
            raw: '# API Endpoint Inventory\n\nSnapshot as of 2026-06-12. Verify via\n`find backend/src/Routes -name \'*.ts\'` before recommending — routes\nget adde'
        },
        {
            name: 'mid-word truncated by source crawler',
            raw: 'riendsTab\'s own `_loadFriends` minus the UI plumbing — the FriendsTab will recompute the same value on its first build later.\n\n## Deep-link'
        }
    ];

    for (const repro of reproducers) {
        it(`swipemeister reproducer: ${repro.name}`, () => {
            const cleaned = sanitizeReason(repro.raw);
            // Universal well-formedness invariants:
            expect(cleaned).not.toContain('```');
            expect(cleaned).not.toContain('[[');
            expect(cleaned).not.toContain(']]');
            expect(cleaned).not.toContain('\n');
            expect(cleaned.length).toBeLessThanOrEqual(140);
            // No leading list/heading/blockquote marker after sanitize.
            expect(cleaned).not.toMatch(/^[#>\-*+]\s/);
        });
    }
});

describe('renderRelatedSection', () => {
    it('returns empty string when there are no links', () => {
        expect(renderRelatedSection([])).toBe('');
    });

    it('emits a clean ## Related heading with one item per line', () => {
        const out = renderRelatedSection([
            link({title: 'Foo', reason: 'because of bar'}),
            link({title: 'Baz', reason: 'see also'})
        ]);

        expect(out).toContain('\n## Related\n');
        const items = out.split('\n').filter((l) => l.startsWith('- '));
        expect(items).toHaveLength(2);
    });

    it('omits the reason tail when reason is empty', () => {
        const out = renderRelatedSection([link({title: 'Foo', reason: ''})]);
        // No " — " separator should appear when there is no reason
        expect(out).not.toContain(' — ');
        expect(out).toContain('[[Foo]] *(score 0.05)*');
    });

    it('keeps every wikilink intact when reasons contain triple backticks', () => {
        // The pre-sanitize bug: an unfenced ``` in one reason opened a code
        // block that swallowed every subsequent list item, so the parser
        // only saw the first 2-3 entries of a 5-link block. We assert by
        // counting bracketed [[…]] in the output — all five must survive.
        const out = renderRelatedSection([
            link({title: 'A', reason: 'plain'}),
            link({title: 'B', reason: '# FigTree\n```\nBaseHttpServer'}),
            link({title: 'C', reason: 'see `code` inline'}),
            link({title: 'D', reason: '| pipe | table |'}),
            link({title: 'E', reason: 'final entry'})
        ]);

        const wikilinkCount = (out.match(/\[\[[^\]]+\]\]/g) ?? []).length;
        expect(wikilinkCount).toBe(5);
        expect(out).not.toContain('\n```');
    });

    it('survives all six swipemeister reproducers in one render', () => {
        const reasons = [
            '# FigTree — HTTP Server & Routes\n\n```\nBaseHttpServer',
            '| `ApiException.dart` | Thin wrapper |\n\n## Domain clients',
            '# Google OAuth — HMAC-Signed State, No Session\n\nFlutter app',
            'Details in [[Backend Setup Hooks & Scheduling]].',
            'Verify via\n`find backend/src/Routes -name \'*.ts\'` before',
            'riendsTab\'s own `_loadFriends` minus the UI plumbing'
        ];
        const out = renderRelatedSection(reasons.map((r, i) =>
            link({title: `Link ${i + 1}`, reason: r})
        ));

        // All six [[wikilinks]] make it through to the output.
        const wikilinks = out.match(/\[\[Link \d\]\]/g) ?? [];
        expect(wikilinks).toHaveLength(6);

        // No unintended fence, no leaked secondary heading, no rogue table
        // row, no embedded backlinks.
        expect(out).not.toContain('```');
        expect(out.split('\n## ')).toHaveLength(2); // exactly one "## " = the Related heading
        expect((out.match(/\[\[Backend Setup Hooks/g) ?? []).length).toBe(0);
    });
});