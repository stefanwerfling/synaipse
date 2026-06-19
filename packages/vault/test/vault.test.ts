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

describe('Vault backlinks via aliases', () => {
    const seed = async (rel: string, frontmatter: Record<string, unknown>, body = ''): Promise<void> => {
        const fm = Object.entries(frontmatter)
            .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
            .join('\n');
        const full = path.join(vaultDir, rel);
        await mkdir(path.dirname(full), {recursive: true});
        await writeFile(full, `---\n${fm}\n---\n${body}`, 'utf8');
    };

    it('resolves a wikilink that uses an alias, not the title', async () => {
        // Target's title is a long, prose-y string; we want short slugs
        // like [[my-decision]] to keep linking text readable.
        await seed('target.md', {
            title: 'A Long Decision Title — Spanning Multiple Words',
            aliases: ['my-decision']
        });
        await seed('source.md', {title: 'Source'}, 'See [[my-decision]] for context.');

        const vault = new Vault(vaultDir);
        await vault.load();

        const backlinks = vault.backlinksOf('target.md');
        expect(backlinks).toEqual(['source.md']);

        const target = vault.tryGet('target.md');
        expect(target?.backlinks).toEqual(['source.md']);
    });

    it('still resolves wikilinks that use the title (alias path does not replace title path)', async () => {
        await seed('target.md', {
            title: 'Canonical Title',
            aliases: ['alt-slug']
        });
        await seed('source.md', {title: 'Source'}, 'Link by title: [[Canonical Title]].');

        const vault = new Vault(vaultDir);
        await vault.load();

        expect(vault.backlinksOf('target.md')).toEqual(['source.md']);
    });

    it('unions backlinks from title-keyed and alias-keyed wikilinks', async () => {
        await seed('target.md', {
            title: 'Canonical Title',
            aliases: ['alt-slug']
        });
        await seed('source-a.md', {title: 'A'}, 'via title [[Canonical Title]]');
        await seed('source-b.md', {title: 'B'}, 'via alias [[alt-slug]]');

        const vault = new Vault(vaultDir);
        await vault.load();

        const backlinks = vault.backlinksOf('target.md').sort();
        expect(backlinks).toEqual(['source-a.md', 'source-b.md']);
    });

    it('title takes precedence when two notes collide on a key', async () => {
        // note-a's title = "X", note-b's alias = "X" → wikilink [[X]]
        // must resolve to note-a (the title owner), not note-b.
        await seed('note-a.md', {title: 'X'});
        await seed('note-b.md', {title: 'Other', aliases: ['X']});
        await seed('source.md', {title: 'S'}, 'See [[X]].');

        const vault = new Vault(vaultDir);
        await vault.load();

        expect(vault.tryGet('note-a.md')?.backlinks).toEqual(['source.md']);
        expect(vault.tryGet('note-b.md')?.backlinks).toEqual([]);
    });

    it('does not crash when a note has no title and no aliases', async () => {
        // edge: a file with only a body, no frontmatter
        const full = path.join(vaultDir, 'plain.md');
        await mkdir(path.dirname(full), {recursive: true});
        await writeFile(full, 'just a body, nothing else', 'utf8');

        const vault = new Vault(vaultDir);
        await vault.load();

        expect(() => vault.backlinksOf('plain.md')).not.toThrow();
        expect(vault.backlinksOf('plain.md')).toEqual([]);
    });
});