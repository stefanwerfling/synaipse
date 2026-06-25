import {describe, it, expect} from 'vitest';
import {auditContextStorage, getAuditTokenLabel} from '../src/AuditContext.js';

describe('AuditContext', () => {
    it('getAuditTokenLabel returns undefined outside a run()', () => {
        expect(getAuditTokenLabel()).toBeUndefined();
    });

    it('exposes tokenLabel inside the run()', () => {
        const inner = auditContextStorage.run({tokenLabel: 'editor-bot'}, () => getAuditTokenLabel());
        expect(inner).toBe('editor-bot');
    });

    it('preserves context across awaits inside run()', async () => {
        const seen = await auditContextStorage.run({tokenLabel: 'crawler'}, async () => {
            await Promise.resolve();
            await Promise.resolve();
            return getAuditTokenLabel();
        });
        expect(seen).toBe('crawler');
    });

    it('returns undefined when context is set without a label', () => {
        const seen = auditContextStorage.run({}, () => getAuditTokenLabel());
        expect(seen).toBeUndefined();
    });

    it('nested run() overrides the outer label', () => {
        const outer = auditContextStorage.run({tokenLabel: 'outer'}, () => {
            return auditContextStorage.run({tokenLabel: 'inner'}, () => getAuditTokenLabel());
        });
        expect(outer).toBe('inner');
    });
});