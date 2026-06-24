import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AuditLog, type AuditEntry} from '../src/AuditLog.js';

let dir: string;
let file: string;
let log: AuditLog;

const sample = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
    ts: Date.now(),
    provider: 'claude-shell',
    providerKind: 'external',
    kind: 'chat',
    noteIds: ['a.md'],
    redactions: [],
    ...overrides
});

beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'audit-test-'));
    file = path.join(dir, 'audit.jsonl');
    log = new AuditLog(file);
});

afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
});

describe('AuditLog', () => {
    it('returns empty when the file does not exist yet', async () => {
        expect(await log.read()).toEqual([]);
        expect(await log.count()).toBe(0);
    });

    it('appends and reads back a single entry', async () => {
        const entry = sample({ts: 1000});
        await log.append(entry);

        const out = await log.read();
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual(entry);
        expect(await log.count()).toBe(1);
    });

    it('returns newest-first', async () => {
        await log.append(sample({ts: 100, question: 'first'}));
        await log.append(sample({ts: 200, question: 'second'}));
        await log.append(sample({ts: 300, question: 'third'}));

        const out = await log.read();
        expect(out.map((e) => e.question)).toEqual(['third', 'second', 'first']);
    });

    it('respects limit (newest N)', async () => {
        for (let i = 0; i < 5; i++) await log.append(sample({ts: i, question: `q${i}`}));
        const out = await log.read({limit: 2});
        expect(out.map((e) => e.question)).toEqual(['q4', 'q3']);
    });

    it('respects afterTs (cursor pagination)', async () => {
        await log.append(sample({ts: 100}));
        await log.append(sample({ts: 200}));
        await log.append(sample({ts: 300}));

        const out = await log.read({afterTs: 150});
        expect(out.map((e) => e.ts)).toEqual([300, 200]);
    });

    it('filters by provider', async () => {
        await log.append(sample({ts: 1, provider: 'claude-shell'}));
        await log.append(sample({ts: 2, provider: 'anthropic'}));
        await log.append(sample({ts: 3, provider: 'claude-shell'}));

        const out = await log.read({provider: 'claude-shell'});
        expect(out).toHaveLength(2);
        expect(out.every((e) => e.provider === 'claude-shell')).toBe(true);
    });

    it('filters by kind', async () => {
        await log.append(sample({ts: 1, kind: 'chat'}));
        await log.append(sample({ts: 2, kind: 'summarize'}));
        await log.append(sample({ts: 3, kind: 'chat'}));

        const out = await log.read({kind: 'chat'});
        expect(out).toHaveLength(2);
        expect(out.every((e) => e.kind === 'chat')).toBe(true);
    });

    it('skips malformed lines instead of failing the whole read', async () => {
        await log.append(sample({ts: 1, question: 'good'}));
        const fs = await import('node:fs/promises');
        await fs.appendFile(file, 'not-valid-json\n');
        await log.append(sample({ts: 2, question: 'also-good'}));

        const out = await log.read();
        expect(out).toHaveLength(2);
        expect(out.map((e) => e.question)).toEqual(['also-good', 'good']);
    });

    it('creates parent directories on first write', async () => {
        const nested = new AuditLog(path.join(dir, 'deep', 'nested', 'audit.jsonl'));
        await nested.append(sample({ts: 1}));
        expect(await nested.count()).toBe(1);
    });

    it('preserves redactions array round-trip', async () => {
        const entry = sample({
            ts: 1,
            redactions: [
                {kind: 'email', count: 3},
                {kind: 'iban', count: 1}
            ]
        });
        await log.append(entry);
        const [out] = await log.read();
        expect(out?.redactions).toEqual([
            {kind: 'email', count: 3},
            {kind: 'iban', count: 1}
        ]);
    });
});