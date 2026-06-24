import {describe, expect, it} from 'vitest';
import type {Note} from '@synaipse/core';
import {isNotePrivate, isPathPrivate} from '../src/Privacy.js';

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