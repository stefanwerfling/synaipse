import {describe, expect, it} from 'vitest';
import type {NoteSummary} from '../src/Api.js';
import {buildFolderTree, firstRowAt, folderOfNoteId, GROUP_ROW_H, layoutRows, noteRowHeight, recencyBucket} from '../src/NotesTree.js';

const note = (id: string, opts: {title?: string; tags?: string[]; mtime?: number} = {}): NoteSummary => ({
    id,
    title: opts.title ?? id.split('/').pop()!.replace(/\.md$/, ''),
    tags: opts.tags ?? [],
    mtime: opts.mtime ?? 0,
    aliases: []
});

const describeRows = (rows: ReturnType<typeof layoutRows>['rows']): string[] =>
    rows.map((r) => r.kind === 'group' ? `${'  '.repeat(r.depth)}[${r.group.label} ${r.totalCount}${r.isCollapsed ? ' +' : ''}]` : `${'  '.repeat(r.depth)}${r.note.id}`);

describe('NotesTree (plan P7 / D2)', () => {
    const notes = [
        note('root.md'),
        note('Memory/decisions/b.md'),
        note('Memory/decisions/a.md'),
        note('Memory/top.md'),
        note('chatgpt-import/uuid-1/x.md'),
        note('chatgpt-import/uuid-2/y.md')
    ];

    it('folder mode: root notes first, folders case-insensitively sorted, subfolders before notes, flat import folders', () => {
        const {rows} = layoutRows(notes, 'folder', new Set(), 0);
        expect(describeRows(rows)).toEqual([
            'root.md',
            '[chatgpt-import 2]',
            '  chatgpt-import/uuid-1/x.md',
            '  chatgpt-import/uuid-2/y.md',
            '[Memory 3]',
            '  [decisions 2]',
            '    Memory/decisions/a.md',
            '    Memory/decisions/b.md',
            '  Memory/top.md'
        ]);
    });

    it('a collapsed folder keeps its header and total, hides everything below', () => {
        const {rows} = layoutRows(notes, 'folder', new Set(['folder:Memory']), 0);
        expect(describeRows(rows)).toEqual([
            'root.md',
            '[chatgpt-import 2]',
            '  chatgpt-import/uuid-1/x.md',
            '  chatgpt-import/uuid-2/y.md',
            '[Memory 3 +]'
        ]);
    });

    it('offsets add up group and note row heights', () => {
        const tagged = [note('a/x.md', {tags: ['t']}), note('a/y.md')];
        const {offsets, height} = layoutRows(tagged, 'folder', new Set(), 0);
        expect(offsets).toEqual([0, GROUP_ROW_H, GROUP_ROW_H + noteRowHeight(tagged[0]!)]);
        expect(height).toBe(GROUP_ROW_H + noteRowHeight(tagged[0]!) + noteRowHeight(tagged[1]!));
        expect(noteRowHeight(tagged[0]!)).toBeGreaterThan(noteRowHeight(tagged[1]!));
    });

    it('tag mode groups by primary tag, biggest first, untagged last', () => {
        const {rows} = layoutRows([
            note('a.md', {tags: ['x']}),
            note('b.md'),
            note('c.md', {tags: ['y']}),
            note('d.md', {tags: ['y', 'x']})
        ], 'tag', new Set(['tag:x']), 0);
        expect(describeRows(rows)).toEqual(['[y 2]', 'c.md', 'd.md', '[x 1 +]', '[untagged 1]', 'b.md']);
    });

    it('recent mode buckets by modification day and drops empty buckets', () => {
        const now = new Date(2026, 10, 19, 12).getTime();
        const day = 86_400_000;
        expect(recencyBucket(now - 1000, now)).toBe('Today');
        expect(recencyBucket(now - day, now)).toBe('Yesterday');
        expect(recencyBucket(now - 40 * day, now)).toBe('Earlier');

        const {rows} = layoutRows([note('old.md', {mtime: now - 40 * day}), note('new.md', {mtime: now})], 'recent', new Set(), now);
        expect(describeRows(rows)).toEqual(['[Today 1]', 'new.md', '[Earlier 1]', 'old.md']);
    });

    it('firstRowAt finds the row under a scroll position', () => {
        const offsets = [0, 32, 88, 144];
        expect(firstRowAt(offsets, 0)).toBe(0);
        expect(firstRowAt(offsets, 31)).toBe(0);
        expect(firstRowAt(offsets, 32)).toBe(1);
        expect(firstRowAt(offsets, 1000)).toBe(3);
        expect(firstRowAt([], 10)).toBe(0);
    });

    it('folder helpers', () => {
        expect(folderOfNoteId('Memory/a/b.md')).toBe('Memory/a');
        expect(folderOfNoteId('b.md')).toBeNull();
        expect(buildFolderTree([note('b.md')]).notes.map((n) => n.id)).toEqual(['b.md']);
    });
});
