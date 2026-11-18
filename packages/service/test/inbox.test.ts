import {describe, expect, it} from 'vitest';
import {bestSection, isInboxNote, parseInbox, withoutInboxEntry} from '../src/Inbox.js';

describe('parseInbox', () => {
    it('splits ### HH:MM blocks and takes a trailing #tag line as tags', () => {
        const content = '### 09:12\n\nVersioning is on.\nSecond line.\n\n#storage #s3\n\n### 14:40\n\nNo tags here.\n\n### 15:00\n\n';

        expect(parseInbox('Memory/k/inbox/2025-11-10.md', content)).toEqual([
            {inbox: 'Memory/k/inbox/2025-11-10.md', date: '2025-11-10', time: '09:12', text: 'Versioning is on.\nSecond line.', tags: ['storage', 's3']},
            {inbox: 'Memory/k/inbox/2025-11-10.md', date: '2025-11-10', time: '14:40', text: 'No tags here.', tags: []}
        ]);
    });

    it('ignores notes that are not inbox files', () => {
        expect(isInboxNote('Memory/k/inbox/2025-11-10.md')).toBe(true);
        expect(isInboxNote('Memory/k/inbox/notes.md')).toBe(false);
        expect(parseInbox('Memory/k/decisions/x.md', '### 09:00\n\ntext')).toEqual([]);
    });
});

describe('bestSection', () => {
    const note = '# Runbook\n\nIntro.\n\n## Deploy\n\nApprove the stage.\n\n## Rollback\n\nRe-run the previous tag to roll back.\nRollback needs no migration.\n\n```\n# not a heading\n```\n\n## Escalation\n\nPage on-call.';

    it('points at the section that mentions the query words most, with its line span', () => {
        expect(bestSection(note, 'how to roll back with rollback')).toEqual({section: 'Rollback', lines: [9, 17]});
        expect(bestSection(note, 'page on-call')).toEqual({section: 'Escalation', lines: [18, 20]});
    });

    it('is null for notes with fewer than two sections or no matching words', () => {
        expect(bestSection('# Only\n\nRollback text.', 'rollback')).toBeNull();
        expect(bestSection(note, 'kubernetes')).toBeNull();
        expect(bestSection(note, 'a an')).toBeNull();
    });
});

describe('withoutInboxEntry', () => {
    const id = 'Memory/k/inbox/2025-11-10.md';
    const content = '### 09:12\n\nFirst.\n\n#a\n\n### 09:12\n\nSecond.\n\n### 10:00\n\nThird.\n';

    it('drops the entry with that time and text, keeps the rest', () => {
        expect(withoutInboxEntry(id, content, '09:12', 'Second.')).toBe('### 09:12\n\nFirst.\n\n#a\n\n### 10:00\n\nThird.\n');
        expect(withoutInboxEntry(id, content, '09:12', 'First.')).toBe('### 09:12\n\nSecond.\n\n### 10:00\n\nThird.\n');
    });

    it('is null for an entry that is not there', () => {
        expect(withoutInboxEntry(id, content, '09:12', 'Third.')).toBeNull();
        expect(withoutInboxEntry(id, content, '11:00', 'First.')).toBeNull();
    });
});
