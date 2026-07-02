import {describe, expect, it} from 'vitest';
import type {Note} from '@synaipse/core';
import {isNotePrivate, isPathPrivate, redactSensitive} from '../src/Privacy.js';

const baseNote = (overrides: Partial<Note> = {}): Note => ({
    id: 'plain.md',
    path: 'plain.md',
    title: 'Plain',
    content: 'just a regular note',
    frontmatter: {},
    tags: [],
    wikilinks: [],
    backlinks: [],
    mtime: 0,
    hash: 'h',
    ...overrides
});

describe('isPathPrivate', () => {
    it.each([
        'Private/notes.md',
        'private/notes.md',
        'Personal/diary.md',
        'PERSONAL/diary.md',
        'secrets/token.md'
    ])('flags %s', (p) => {
        expect(isPathPrivate(p)).toBe(true);
    });

    it.each([
        'public/notes.md',
        'Memory/projects/foo.md',
        'PrivateButNotPrefix.md',
        'a/Private/leaf.md'
    ])('passes %s through', (p) => {
        expect(isPathPrivate(p)).toBe(false);
    });
});

describe('isNotePrivate', () => {
    it('flags notes with frontmatter.private: true', () => {
        expect(isNotePrivate(baseNote({frontmatter: {private: true}}))).toBe(true);
    });

    it('flags notes with frontmatter.dsgvo: true', () => {
        expect(isNotePrivate(baseNote({frontmatter: {dsgvo: true}}))).toBe(true);
    });

    it('does NOT flag when frontmatter.private is falsy', () => {
        expect(isNotePrivate(baseNote({frontmatter: {private: false}}))).toBe(false);
        expect(isNotePrivate(baseNote({frontmatter: {private: 'maybe' as unknown as boolean}}))).toBe(false);
    });

    it('flags notes carrying the "private" tag (case-insensitive, with or without #)', () => {
        expect(isNotePrivate(baseNote({tags: ['private']}))).toBe(true);
        expect(isNotePrivate(baseNote({tags: ['Private']}))).toBe(true);
        expect(isNotePrivate(baseNote({tags: ['#private']}))).toBe(true);
        expect(isNotePrivate(baseNote({tags: ['public', 'private', 'foo']}))).toBe(true);
    });

    it('flags notes living under Private/, Personal/ or secrets/', () => {
        expect(isNotePrivate(baseNote({id: 'Private/diary.md', path: 'Private/diary.md'}))).toBe(true);
        expect(isNotePrivate(baseNote({id: 'personal/bills.md', path: 'personal/bills.md'}))).toBe(true);
        expect(isNotePrivate(baseNote({id: 'secrets/tokens.md', path: 'secrets/tokens.md'}))).toBe(true);
    });

    it('returns false for plain public notes', () => {
        expect(isNotePrivate(baseNote())).toBe(false);
        expect(isNotePrivate(baseNote({tags: ['public', 'notes']}))).toBe(false);
        expect(isNotePrivate(baseNote({frontmatter: {title: 'Plain'}}))).toBe(false);
    });
});

describe('redactSensitive', () => {
    it('redacts email addresses', () => {
        const {redacted, hits} = redactSensitive('Schreib mir an alice@example.com bitte.');
        expect(redacted).toBe('Schreib mir an [redact:email] bitte.');
        expect(hits).toContainEqual({kind: 'email', count: 1});
    });

    it('redacts JWTs as one token, not three', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
        const {redacted, hits} = redactSensitive(`Token: ${jwt}`);
        expect(redacted).toBe('Token: [redact:jwt]');
        expect(hits).toContainEqual({kind: 'jwt', count: 1});
    });

    it('redacts OpenAI, Anthropic, GitHub, AWS and Slack tokens', () => {
        const input = [
            'OpenAI sk-proj-abc123XYZ456defg7890hij',
            'Anthropic sk-ant-api03-abc123XYZ456defghijklm',
            'GitHub ghp_abcDEF123ghi456JKL789mno012PQR345',
            'AWS AKIAIOSFODNN7EXAMPLE',
            'Slack xoxb-123456789-987654321-abcXYZabcXYZ'
        ].join('\n');

        const {hits} = redactSensitive(input);
        const kinds = hits.map((h) => h.kind);

        expect(kinds).toContain('openai_key');
        expect(kinds).toContain('anthropic_key');
        expect(kinds).toContain('github_token');
        expect(kinds).toContain('aws_key');
        expect(kinds).toContain('slack_token');
    });

    it('redacts a valid Luhn credit-card number, leaves invalid digit-runs alone', () => {
        // 4242 4242 4242 4242 is the canonical Stripe test number — passes Luhn
        const valid = redactSensitive('Karte: 4242 4242 4242 4242');
        expect(valid.redacted).toBe('Karte: [redact:card]');
        expect(valid.hits).toContainEqual({kind: 'creditcard', count: 1});

        const invalid = redactSensitive('Order: 1234 5678 9012 3456');
        expect(invalid.redacted).toBe('Order: 1234 5678 9012 3456');
        expect(invalid.hits.find((h) => h.kind === 'creditcard')).toBeUndefined();
    });

    it('redacts IBAN and BIC', () => {
        const {hits} = redactSensitive('IBAN DE89370400440532013000 BIC COBADEFFXXX');
        expect(hits.map((h) => h.kind)).toEqual(expect.arrayContaining(['iban', 'bic']));
    });

    it('redacts password-field values but keeps the field name', () => {
        const cases = [
            'password: secret123',
            'Passwort: meinGeheimnis!',
            'password = topSecret42'
        ];
        for (const c of cases) {
            const {redacted, hits} = redactSensitive(c);
            expect(redacted).toMatch(/[Pp]assw(?:or[dt])\s*[:=]\s*\[redact:password\]/);
            expect(hits).toContainEqual({kind: 'password', count: 1});
        }
    });

    it('does not redact placeholder password values shorter than 6 chars', () => {
        const {redacted} = redactSensitive('password: TODO');
        expect(redacted).toBe('password: TODO');
    });

    it('redacts IPv4 addresses, leaves ports/version-numbers alone', () => {
        const {redacted} = redactSensitive('Server 192.168.1.10 läuft auf v1.2.3 mit Port 8080.');
        expect(redacted).toContain('[redact:ipv4]');
        expect(redacted).toContain('v1.2.3');
        expect(redacted).toContain('8080');
    });

    it('redacts international phone numbers (with + or 00 prefix)', () => {
        const {hits} = redactSensitive('Call +49 30 12345678 or 0049 89 9876543.');
        const phone = hits.find((h) => h.kind === 'phone');
        expect(phone?.count).toBeGreaterThanOrEqual(2);
    });

    it('counts multiple emails as separate hits', () => {
        const {redacted, hits} = redactSensitive('Cc: a@x.com, b@y.de, c@z.org');
        expect((redacted.match(/\[redact:email\]/g) ?? []).length).toBe(3);
        expect(hits).toContainEqual({kind: 'email', count: 3});
    });

    it('is idempotent — running twice yields the same redacted text', () => {
        const once = redactSensitive('Ping alice@example.com from 10.0.0.5.');
        const twice = redactSensitive(once.redacted);
        expect(twice.redacted).toBe(once.redacted);
    });

    it('returns empty hits array for clean text', () => {
        const {redacted, hits} = redactSensitive('Just a regular sentence about clusters.');
        expect(redacted).toBe('Just a regular sentence about clusters.');
        expect(hits).toEqual([]);
    });

    it('returns hits sorted by kind for stable UI rendering', () => {
        const {hits} = redactSensitive('mail a@b.de ipv4 10.0.0.1 iban DE89370400440532013000');
        const kinds = hits.map((h) => h.kind);
        const sorted = [...kinds].sort((a, b) => a.localeCompare(b));
        expect(kinds).toEqual(sorted);
    });

    describe('manual DSGVO marker [[dsgvo:kind|text]]', () => {
        it('replaces the whole marker with [redact:<kind>] and preserves the user-chosen kind', () => {
            const {redacted, hits} = redactSensitive('Patient [[dsgvo:name|Max Mustermann]] gemeldet.');
            expect(redacted).toBe('Patient [redact:name] gemeldet.');
            expect(hits).toContainEqual({kind: 'dsgvo:name', count: 1});
        });

        it('supports custom labels that no auto-detector would catch', () => {
            const {redacted, hits} = redactSensitive('ID [[dsgvo:patient-id|MG-88421]] siehe Akte.');
            expect(redacted).toBe('ID [redact:patient-id] siehe Akte.');
            expect(hits).toContainEqual({kind: 'dsgvo:patient-id', count: 1});
        });

        it('runs before auto-detectors so wrapped emails keep the user kind, not `email`', () => {
            const {redacted, hits} = redactSensitive('Reply to [[dsgvo:contact|alice@example.com]] soon.');
            expect(redacted).toBe('Reply to [redact:contact] soon.');
            expect(hits.map((h) => h.kind)).toContain('dsgvo:contact');
            expect(hits.map((h) => h.kind)).not.toContain('email');
        });

        it('handles multiple manual markers as separate hits per kind', () => {
            const input = '[[dsgvo:name|Alice]] wohnt in [[dsgvo:address|Berlin]], siehe auch [[dsgvo:name|Bob]].';
            const {redacted, hits} = redactSensitive(input);
            expect(redacted).toBe('[redact:name] wohnt in [redact:address], siehe auch [redact:name].');
            expect(hits).toContainEqual({kind: 'dsgvo:name', count: 2});
            expect(hits).toContainEqual({kind: 'dsgvo:address', count: 1});
        });

        it('is idempotent — a second pass does not re-match [redact:…]', () => {
            const once = redactSensitive('[[dsgvo:name|Hans]] kommt gleich.');
            const twice = redactSensitive(once.redacted);
            expect(twice.redacted).toBe(once.redacted);
        });
    });
});