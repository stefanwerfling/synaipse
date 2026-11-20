import {describe, expect, it} from 'vitest';
import {buildFlushStatement, mergeDirty} from '../src/MariaDBNoteAdapter.js';

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
