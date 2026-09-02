import {describe, it, expect} from 'vitest';
import {
    type NoteRefTarget,
    canonicalNoteLink,
    resolveNoteRef,
    resolveNoteRefTarget
} from '../src/Index.js';

const notes: NoteRefTarget[] = [
    {
        id: 'Memory/kavula/decisions/invoice-split.md',
        title: 'Invoice Split (2 Rechnungen pro Auftrag)',
        aliases: ['Rechnungs-Split']
    },
    {id: 'Memory/kavula/architecture/wws-warehouse-concept.md', title: 'WWS / Lagerverwaltung — Konzept (Kavula)'},
    {id: 'Memory/synaipse/index.md', title: 'Index'}
];

describe('resolveNoteRef', () => {
    it('resolves an exact note id', () => {
        expect(resolveNoteRef('Memory/kavula/decisions/invoice-split.md', notes)).toBe(
            'Memory/kavula/decisions/invoice-split.md'
        );
    });

    it('resolves a path missing the .md suffix', () => {
        expect(resolveNoteRef('Memory/kavula/decisions/invoice-split', notes)).toBe(
            'Memory/kavula/decisions/invoice-split.md'
        );
    });

    it('resolves an exact title', () => {
        expect(resolveNoteRef('Invoice Split (2 Rechnungen pro Auftrag)', notes)).toBe(
            'Memory/kavula/decisions/invoice-split.md'
        );
    });

    it('resolves an alias', () => {
        expect(resolveNoteRef('Rechnungs-Split', notes)).toBe('Memory/kavula/decisions/invoice-split.md');
    });

    it('resolves a bare filename slug', () => {
        expect(resolveNoteRef('wws-warehouse-concept', notes)).toBe(
            'Memory/kavula/architecture/wws-warehouse-concept.md'
        );
    });

    it('resolves case-insensitively when unambiguous', () => {
        expect(resolveNoteRef('WWS-WAREHOUSE-CONCEPT', notes)).toBe(
            'Memory/kavula/architecture/wws-warehouse-concept.md'
        );
    });

    it('returns null for a phantom memory-slug reference', () => {
        // The exact bug: an auto-memory name slug that is no id/title/alias.
        expect(resolveNoteRef('project_invoice_split', notes)).toBeNull();
    });

    it('returns null for blank input', () => {
        expect(resolveNoteRef('   ', notes)).toBeNull();
    });

    it('returns the whole target from resolveNoteRefTarget', () => {
        const t = resolveNoteRefTarget('invoice-split', notes);
        expect(t?.title).toBe('Invoice Split (2 Rechnungen pro Auftrag)');
    });
});

describe('canonicalNoteLink', () => {
    it('prefers the title', () => {
        expect(canonicalNoteLink(notes[0])).toBe('Invoice Split (2 Rechnungen pro Auftrag)');
    });

    it('falls back to the id when title is empty', () => {
        expect(canonicalNoteLink({id: 'Memory/x/y.md', title: ''})).toBe('Memory/x/y.md');
    });
});
