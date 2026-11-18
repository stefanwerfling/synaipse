import {describe, expect, it} from 'vitest';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * Plan P9 / E4: pkgstudio.module.json tells PKG Studio where the built
 * entries are and what the module can do. These checks keep it in step
 * with the package exports, the real export names and the schema.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readJson = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(repo, rel), 'utf8')) as Record<string, unknown>;

const manifest = readJson('pkgstudio.module.json');
const schema = readJson('doc/pkgstudio.module.schema.json');
const webPkg = readJson('packages/web/package.json') as {version: string; exports: Record<string, string | {import?: string; default?: string}>};

type Schema = {
    type?: string;
    const?: unknown;
    enum?: unknown[];
    pattern?: string;
    minLength?: number;
    required?: string[];
    properties?: Record<string, Schema>;
    additionalProperties?: boolean;
    items?: Schema;
    uniqueItems?: boolean;
};

/** The JSON Schema subset the manifest schema uses; returns every violation. */
const validate = (value: unknown, s: Schema, at = '$'): string[] => {
    const errors: string[] = [];
    if (s.const !== undefined && value !== s.const) errors.push(`${at}: must be ${JSON.stringify(s.const)}`);
    if (s.enum !== undefined && !s.enum.includes(value)) errors.push(`${at}: not one of ${s.enum.join(', ')}`);
    if (s.type === 'string') {
        if (typeof value !== 'string') return [...errors, `${at}: not a string`];
        if (s.pattern !== undefined && !new RegExp(s.pattern).test(value)) errors.push(`${at}: does not match ${s.pattern}`);
        if (s.minLength !== undefined && value.length < s.minLength) errors.push(`${at}: too short`);
    }
    if (s.type === 'boolean' && typeof value !== 'boolean') errors.push(`${at}: not a boolean`);
    if (s.type === 'array') {
        if (!Array.isArray(value)) return [...errors, `${at}: not an array`];
        if (s.uniqueItems === true && new Set(value).size !== value.length) errors.push(`${at}: duplicates`);
        value.forEach((v, i) => errors.push(...validate(v, s.items ?? {}, `${at}[${i}]`)));
    }
    if (s.type === 'object') {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return [...errors, `${at}: not an object`];
        const obj = value as Record<string, unknown>;
        for (const key of s.required ?? []) if (!(key in obj)) errors.push(`${at}: missing ${key}`);
        for (const [key, v] of Object.entries(obj)) {
            const sub = s.properties?.[key];
            if (sub === undefined) {
                if (s.additionalProperties === false) errors.push(`${at}: unknown ${key}`);
            } else {
                errors.push(...validate(v, sub, `${at}.${key}`));
            }
        }
    }
    return errors;
};

const target = (key: string): string | undefined => {
    const entry = webPkg.exports[key];
    if (entry === undefined) return undefined;
    return typeof entry === 'string' ? entry : entry.import ?? entry.default;
};

/** Package-relative export target → repo-relative path. */
const inRepo = (pkgPath: string | undefined): string | undefined =>
    pkgPath === undefined ? undefined : path.posix.join('packages/web', pkgPath);

const entries = manifest.entries as {
    frontend: {module: string; css: string; export: string; source: string; package: string};
    backend: {module: string; export: string; package: string};
};

describe('pkgstudio.module.json', () => {
    it('matches its schema', () => {
        expect(validate(manifest, schema as Schema)).toEqual([]);
    });

    it('the validator catches what the schema forbids', () => {
        expect(validate({...manifest, extra: 1}, schema as Schema)).toEqual(['$: unknown extra']);
        expect(validate({...manifest, capabilities: ['teleport']}, schema as Schema)).toHaveLength(1);
        expect(validate({...manifest, color: 'teal'}, schema as Schema)).toHaveLength(1);
    });

    it('points at the same files as the package exports', () => {
        const sub = (pkg: string): string => `.${pkg.slice('@synaipse/web'.length)}`;
        expect(inRepo(target(sub(entries.frontend.package)))).toBe(entries.frontend.module);
        expect(inRepo(target(`${sub(entries.frontend.package)}.css`))).toBe(entries.frontend.css);
        expect(inRepo(target(`${sub(entries.frontend.package)}/source`))).toBe(entries.frontend.source);
        expect(inRepo(target(sub(entries.backend.package)))).toBe(entries.backend.module);
        expect(manifest.version).toBe(webPkg.version);
    });

    it('names exports that exist', async () => {
        expect(existsSync(path.join(repo, entries.frontend.source))).toBe(true);
        const mountSource = readFileSync(path.join(repo, entries.frontend.source), 'utf8');
        expect(mountSource).toMatch(new RegExp(`export (async )?function ${entries.frontend.export}\\b`));

        const backend = await import('../server/embed.js') as Record<string, unknown>;
        expect(typeof backend[entries.backend.export]).toBe('function');
    });

    it('declares only what the code offers', () => {
        const mountSource = readFileSync(path.join(repo, entries.frontend.source), 'utf8');
        const caps = manifest.capabilities as string[];
        if (caps.includes('theme-switch')) expect(mountSource).toContain('onThemeChange?:');
        if (caps.includes('mount-handle')) {
            for (const m of ['unmount', 'onShow', 'onHide', 'navigate', 'setTheme', 'getTheme']) expect(mountSource).toContain(`${m}(`);
        }
        const styles = readFileSync(path.join(repo, 'packages/web/src/Styles.css'), 'utf8');
        if (caps.includes('shell-tokens')) expect(styles).toContain('var(--sh-');
        const embed = readFileSync(path.join(repo, 'packages/web/server/embed.ts'), 'utf8');
        if (caps.includes('mcp-registrar')) expect(embed).toContain('mcpRegistrar: SynaipseRegistrar;');
        if (caps.includes('health')) expect(embed).toContain('health(): SynaipseHealth;');
    });
});
