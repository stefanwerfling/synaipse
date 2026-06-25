import {describe, it, expect} from 'vitest';
import type {Note, NoteId, Frontmatter} from '@synaipse/core';
import {findDecayCandidates, archivePathFor} from '../src/MemoryDecay.js';

const MS_PER_DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 25);

const note = (
    id: NoteId,
    opts: {
        title?: string;
        tags?: string[];
        backlinks?: NoteId[];
        frontmatter?: Frontmatter;
        ageDays?: number;
    } = {}
): Note => ({
    id,
    path: id,
    title: opts.title ?? id,
    content: '',
    frontmatter: opts.frontmatter ?? {},
    tags: opts.tags ?? [],
    wikilinks: [],
    backlinks: opts.backlinks ?? [],
    mtime: NOW - (opts.ageDays ?? 100) * MS_PER_DAY,
    hash: 'h'
});

describe('findDecayCandidates', () => {
    it('returns notes with no backlinks, no tags, old mtime', () => {
        const notes = [
            note('orphan-old.md', {ageDays: 120}),
            note('orphan-fresh.md', {ageDays: 10}),
            note('linked-old.md', {ageDays: 200, backlinks: ['other.md']}),
            note('tagged-old.md', {ageDays: 200, tags: ['ref']})
        ];

        const result = findDecayCandidates(notes, NOW);

        expect(result.map((c) => c.id)).toEqual(['orphan-old.md']);
        expect(result[0]?.ageDays).toBe(120);
    });

    it('excludes pinned notes regardless of age', () => {
        const notes = [
            note('pinned.md', {ageDays: 365, frontmatter: {pinned: true} as Frontmatter}),
            note('regular.md', {ageDays: 365})
        ];

        const result = findDecayCandidates(notes, NOW);

        expect(result.map((c) => c.id)).toEqual(['regular.md']);
    });

    it('excludes prime/index notes regardless of age', () => {
        const notes = [
            note('index.md', {ageDays: 365, frontmatter: {prime: true} as Frontmatter}),
            note('regular.md', {ageDays: 365})
        ];

        const result = findDecayCandidates(notes, NOW);

        expect(result.map((c) => c.id)).toEqual(['regular.md']);
    });

    it('excludes notes already under the archive prefix', () => {
        const notes = [
            note('Archive/already-old.md', {ageDays: 365}),
            note('fresh-orphan.md', {ageDays: 200})
        ];

        const result = findDecayCandidates(notes, NOW);

        expect(result.map((c) => c.id)).toEqual(['fresh-orphan.md']);
    });

    it('honours olderThanDays threshold', () => {
        const notes = [
            note('a.md', {ageDays: 100}),
            note('b.md', {ageDays: 50}),
            note('c.md', {ageDays: 31})
        ];

        const result = findDecayCandidates(notes, NOW, {olderThanDays: 30});

        expect(result.map((c) => c.id)).toEqual(['a.md', 'b.md', 'c.md']);

        const stricter = findDecayCandidates(notes, NOW, {olderThanDays: 60});

        expect(stricter.map((c) => c.id)).toEqual(['a.md']);
    });

    it('restricts to pathPrefix when provided', () => {
        const notes = [
            note('Crawler/dust.md', {ageDays: 200}),
            note('Memory/dust.md', {ageDays: 200})
        ];

        const result = findDecayCandidates(notes, NOW, {pathPrefix: 'Crawler/'});

        expect(result.map((c) => c.id)).toEqual(['Crawler/dust.md']);
    });

    it('sorts oldest first and respects limit', () => {
        const notes = [
            note('young.md', {ageDays: 91}),
            note('mid.md', {ageDays: 200}),
            note('ancient.md', {ageDays: 700})
        ];

        const result = findDecayCandidates(notes, NOW, {limit: 2});

        expect(result.map((c) => c.id)).toEqual(['ancient.md', 'mid.md']);
    });

    it('uses a configurable archivePrefix', () => {
        const notes = [
            note('Old/already.md', {ageDays: 200}),
            note('elsewhere.md', {ageDays: 200})
        ];

        const result = findDecayCandidates(notes, NOW, {archivePrefix: 'Old/'});

        expect(result.map((c) => c.id)).toEqual(['elsewhere.md']);
    });
});

describe('archivePathFor', () => {
    it('prepends the archive prefix', () => {
        expect(archivePathFor('Memory/foo.md')).toBe('Archive/Memory/foo.md');
    });

    it('is idempotent for already-archived paths', () => {
        expect(archivePathFor('Archive/Memory/foo.md')).toBe('Archive/Memory/foo.md');
    });

    it('respects a custom archive prefix', () => {
        expect(archivePathFor('foo.md', 'Old/')).toBe('Old/foo.md');
        expect(archivePathFor('Old/foo.md', 'Old/')).toBe('Old/foo.md');
    });
});