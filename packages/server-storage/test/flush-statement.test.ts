import {describe, expect, it} from 'vitest';
import {buildFlushStatement, MAX_CHANGES_PER_POLL, mergeDirty, planChanges} from '../src/MariaDBNoteAdapter.js';

describe('access-journal flush (A6)', () => {
    it('builds one UPDATE … JOIN with nine parameters per row plus the vault id', () => {
        const {sql, params} = buildFlushStatement(7, [['a.md', {accessDelta: 2, lastAccessed: 10}], ['b.md', {embeddedHash: 'h'}]]);
        expect(sql.match(/UNION ALL/g)).toHaveLength(1);
        expect(sql).toContain('n.access_count + COALESCE(d.ad, 0)');
        expect(sql).not.toContain('INSERT');
        expect(params).toHaveLength(19);
        expect(params.slice(0, 9)).toEqual(['a.md', null, null, 2, 10, null, null, null, null]);
        expect(params[18]).toBe(7);
    });

    it('merges deltas by adding and other fields by taking the newer value', () => {
        expect(mergeDirty({accessDelta: 2, lastAccessed: 5, hash: 'old'}, {accessDelta: 1, lastAccessed: 9})).toEqual(
            {accessDelta: 3, lastAccessed: 9, hash: 'old'});
        expect(mergeDirty({referencedDelta: 1}, {hash: 'new'})).toEqual({referencedDelta: 1, hash: 'new'});
    });
});

describe('change-log planning (A6)', () => {
    const row = (version: number, note_path: string, op: 'write' | 'delete' = 'write') => ({version, note_path, op});
    const never = () => false;

    it('re-reads each foreign path once, newest change wins, own changes skipped', () => {
        const plan = planChanges(10, 14, [row(11, 'a'), row(12, 'b'), row(13, 'a', 'delete'), row(14, 'c')],
            (path, version) => path === 'c' && version === 14);
        expect(plan).toEqual({reset: false, paths: ['a', 'b']});
    });

    it('resets on a gap in the log (pruned) or when too far behind', () => {
        expect(planChanges(10, 14, [row(13, 'a'), row(14, 'b')], never)).toEqual({reset: true});
        expect(planChanges(0, MAX_CHANGES_PER_POLL + 1, [], never)).toEqual({reset: true});
    });
});
