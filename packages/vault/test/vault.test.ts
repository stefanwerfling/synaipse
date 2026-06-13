import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {VaultError} from '@synaipse/core';
import {Vault} from '../src/Vault.js';

let vaultDir: string;

beforeEach(async () => {
    vaultDir = await mkdtemp(path.join(tmpdir(), 'synaipse-vault-'));
});

afterEach(async () => {
    await rm(vaultDir, {recursive: true, force: true});
});

describe('Vault.write frontmatter validation', () => {
    it('accepts valid extended frontmatter', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const note = await vault.write({
            path: 'decisions/cluster.md',
            content: '# Cluster\n\nbody',
            frontmatter: {
                title: 'Cluster',
                type: 'decision',
                why: 'app too large',
                confidence: 0.9,
                sources: ['[[ADR-001]]'],
                supersedes: ['Cluster v1']
            }
        });

        expect(note.frontmatter.type).toBe('decision');
        expect(note.frontmatter.confidence).toBe(0.9);
    });

    it('rejects an invalid note type', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        await expect(vault.write({
            path: 'bad.md',
            content: 'x',
            frontmatter: {type: 'meeting' as never}
        })).rejects.toBeInstanceOf(VaultError);
    });

    it('rejects confidence outside [0, 1]', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        await expect(vault.write({
            path: 'bad.md',
            content: 'x',
            frontmatter: {confidence: 1.5}
        })).rejects.toThrow(/confidence/);
    });

    it('accepts unknown frontmatter keys', async () => {
        const vault = new Vault(vaultDir);
        await vault.load();

        const note = await vault.write({
            path: 'open.md',
            content: 'x',
            frontmatter: {title: 'X', last_verified: '2026-06-13'}
        });

        expect(note.frontmatter.last_verified).toBe('2026-06-13');
    });
});

describe('Vault ingest with invalid frontmatter', () => {
    it('warns but still ingests a note with bad type', async () => {
        const filePath = path.join(vaultDir, 'legacy.md');
        await mkdir(path.dirname(filePath), {recursive: true});
        await writeFile(filePath, '---\ntype: meeting\n---\nbody', 'utf8');

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const vault = new Vault(vaultDir);
        await vault.load();

        expect(vault.tryGet('legacy.md')).toBeDefined();
        expect(warn).toHaveBeenCalled();
        expect(warn.mock.calls.flat().join(' ')).toMatch(/type/);

        warn.mockRestore();
    });
});