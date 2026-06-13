import {describe, it, expect} from 'vitest';
import {groupTags, filterEntries, groupLabel, isUngrouped} from '../src/TagGroups.js';

const entry = (tag: string, count: number) => ({tag, count});

describe('groupTags', () => {
    it('groups tags by first / segment', () => {
        const groups = groupTags([
            entry('project/app-a', 10),
            entry('project/app-b', 5),
            entry('architecture/cluster', 3),
            entry('adr', 7)
        ]);

        const names = groups.map((g) => g.name);
        expect(names).toContain('project');
        expect(names).toContain('architecture');
        expect(names).toContain('');
    });

    it('sorts groups by total descending, ungrouped last', () => {
        const groups = groupTags([
            entry('adr', 30),
            entry('project/app-a', 5),
            entry('project/app-b', 5),
            entry('architecture/x', 7)
        ]);

        const names = groups.map((g) => g.name);
        expect(names).toEqual(['project', 'architecture', '']);
    });

    it('sorts entries within a group by count desc then alphabetically', () => {
        const [group] = groupTags([
            entry('project/zeta', 5),
            entry('project/alpha', 5),
            entry('project/beta', 9)
        ]);

        expect(group?.entries.map((e) => e.tag)).toEqual([
            'project/beta',
            'project/alpha',
            'project/zeta'
        ]);
    });

    it('computes per-group totals', () => {
        const [project] = groupTags([
            entry('project/a', 4),
            entry('project/b', 6)
        ]);
        expect(project?.total).toBe(10);
    });

    it('handles only-ungrouped tags', () => {
        const groups = groupTags([entry('adr', 3), entry('bug', 2)]);
        expect(groups.length).toBe(1);
        expect(groups[0]?.name).toBe('');
        expect(groups[0]?.entries.map((e) => e.tag)).toEqual(['adr', 'bug']);
    });

    it('returns an empty array for no input', () => {
        expect(groupTags([])).toEqual([]);
    });
});

describe('filterEntries', () => {
    const entries = [
        entry('project/app-a', 1),
        entry('project/app-b', 1),
        entry('architecture/cluster', 1)
    ];

    it('returns all on empty query', () => {
        expect(filterEntries(entries, '').length).toBe(3);
        expect(filterEntries(entries, '   ').length).toBe(3);
    });

    it('matches case-insensitively on substring', () => {
        const result = filterEntries(entries, 'APP');
        expect(result.map((e) => e.tag).sort()).toEqual(['project/app-a', 'project/app-b']);
    });

    it('matches on group prefix', () => {
        const result = filterEntries(entries, 'architecture');
        expect(result.length).toBe(1);
    });

    it('returns empty for no match', () => {
        expect(filterEntries(entries, 'zzz')).toEqual([]);
    });
});

describe('groupLabel + isUngrouped', () => {
    it('replaces empty name with "other"', () => {
        expect(groupLabel('')).toBe('other');
        expect(groupLabel('project')).toBe('project');
    });

    it('flags ungrouped only for empty name', () => {
        expect(isUngrouped('')).toBe(true);
        expect(isUngrouped('project')).toBe(false);
    });
});