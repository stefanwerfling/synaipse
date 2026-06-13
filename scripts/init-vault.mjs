#!/usr/bin/env node
import {cp, mkdir, readdir, stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import 'dotenv/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const templateRoot = path.join(repoRoot, 'templates', 'vault');

const target = path.resolve(process.env.SYNAIPSE_VAULT_PATH ?? path.join(repoRoot, 'vault'));

const EMPTY_DIRS = ['Memory/bugs', 'Memory/research'];

const copyRecursive = async (src, dst) => {
    const entries = await readdir(src, {withFileTypes: true});

    for (const entry of entries) {
        const from = path.join(src, entry.name);
        const to = path.join(dst, entry.name);

        if (entry.isDirectory()) {
            await mkdir(to, {recursive: true});
            await copyRecursive(from, to);
            continue;
        }

        if (entry.isFile()) {
            if (existsSync(to)) {
                process.stdout.write(`skip   ${path.relative(target, to)}\n`);
                continue;
            }

            await cp(from, to);
            process.stdout.write(`write  ${path.relative(target, to)}\n`);
        }
    }
};

const main = async () => {
    if (!existsSync(templateRoot)) {
        process.stderr.write(`Template not found at ${templateRoot}\n`);
        process.exit(1);
    }

    try {
        const info = await stat(target);

        if (!info.isDirectory()) {
            process.stderr.write(`Vault path exists but is not a directory: ${target}\n`);
            process.exit(1);
        }
    } catch {
        await mkdir(target, {recursive: true});
    }

    process.stdout.write(`vault: ${target}\n`);

    await copyRecursive(templateRoot, target);

    for (const rel of EMPTY_DIRS) {
        const dir = path.join(target, rel);
        await mkdir(dir, {recursive: true});
    }

    process.stdout.write('done.\n');
};

main().catch((error) => {
    process.stderr.write(`init-vault failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
});