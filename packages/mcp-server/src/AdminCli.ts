#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config as dotenvConfig} from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
process.chdir(repoRoot);
dotenvConfig();

const {loadConfigFromEnv} = await import('@synaipse/core');
const {createServerAdapters} = await import('@synaipse/server-storage');

interface ParsedFlags {
    email?: string;
    password?: string;
}

const parseFlags = (argv: readonly string[]): ParsedFlags => {
    const out: ParsedFlags = {};

    for (const arg of argv) {
        if (arg.startsWith('--email=')) {
            out.email = arg.slice('--email='.length);
        } else if (arg.startsWith('--password=')) {
            out.password = arg.slice('--password='.length);
        }
    }

    return out;
};

const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
};

const main = async (): Promise<number> => {
    const args = process.argv.slice(2);
    const sub = args[0];

    if (sub === undefined) {
        process.stderr.write('usage: npm run admin <bootstrap|list|set-admin|disable|enable|reset-password> [flags]\n');
        return 2;
    }

    const config = loadConfigFromEnv();

    if (config.mode !== 'server') {
        process.stderr.write(
            'admin CLI requires SYNAIPSE_MODE=server (accounts table lives in MariaDB). '
            + 'Local mode has no concept of web-UI accounts.\n'
        );
        return 2;
    }

    if (config.mariadb === undefined) {
        process.stderr.write('config.mariadb is missing — check your env / config.\n');
        return 2;
    }

    const bundle = await createServerAdapters(config.mariadb);

    try {
        if (sub === 'bootstrap') {
            const flags = parseFlags(args.slice(1));
            if (flags.email === undefined || flags.email.length === 0) {
                process.stderr.write('admin bootstrap requires --email=<email>\n');
                return 2;
            }
            if (flags.password === undefined || flags.password.length === 0) {
                process.stderr.write('admin bootstrap requires --password=<password>\n');
                return 2;
            }

            // Idempotent: if an account with this email already exists,
            // print a notice and exit 0 instead of failing. Re-running the
            // bootstrap on an already-seeded DB is a normal operator
            // workflow (e.g. container restart with same env vars).
            const existing = await bundle.accounts.findByEmail(flags.email);
            if (existing !== null) {
                log(`[admin] account "${flags.email}" already exists (id=${existing.id}, admin=${existing.isAdmin})`);
                log('[admin] bootstrap skipped — use reset-password if the password needs to change');
                return 0;
            }

            const account = await bundle.accounts.create({
                email: flags.email,
                password: flags.password,
                isAdmin: true
            });

            log(`[admin] bootstrapped admin "${account.email}" (id=${account.id})`);
            return 0;
        }

        if (sub === 'list') {
            const accounts = await bundle.accounts.listAccounts();
            if (accounts.length === 0) {
                log('[admin] no accounts in this vault');
                return 0;
            }

            for (const a of accounts) {
                const status = a.disabledAt !== null ? 'DISABLED' : 'active';
                const role = a.isAdmin ? 'admin' : 'user';
                const lastLogin = a.lastLoginAt !== null ? new Date(a.lastLoginAt).toISOString() : 'never';
                log(`[admin] ${status.padEnd(8)} #${a.id} ${a.email} (${role}) last=${lastLogin}`);
            }
            return 0;
        }

        if (sub === 'set-admin' || sub === 'disable' || sub === 'enable' || sub === 'reset-password') {
            const flags = parseFlags(args.slice(1));
            if (flags.email === undefined || flags.email.length === 0) {
                process.stderr.write(`admin ${sub} requires --email=<email>\n`);
                return 2;
            }

            const account = await bundle.accounts.findByEmail(flags.email);
            if (account === null) {
                log(`[admin] no account with email "${flags.email}"`);
                return 1;
            }

            if (sub === 'set-admin') {
                await bundle.accounts.setAdmin(account.id, true);
                log(`[admin] "${account.email}" is now admin`);
                return 0;
            }

            if (sub === 'disable') {
                await bundle.accounts.setDisabled(account.id, true);
                log(`[admin] disabled "${account.email}"`);
                return 0;
            }

            if (sub === 'enable') {
                await bundle.accounts.setDisabled(account.id, false);
                log(`[admin] enabled "${account.email}"`);
                return 0;
            }

            if (sub === 'reset-password') {
                if (flags.password === undefined || flags.password.length === 0) {
                    process.stderr.write('admin reset-password requires --password=<new-password>\n');
                    return 2;
                }
                await bundle.accounts.setPassword(account.id, flags.password);
                log(`[admin] reset password for "${account.email}"`);
                return 0;
            }
        }

        process.stderr.write(`unknown admin subcommand: ${sub}\n`);
        return 2;
    } finally {
        await bundle.close();
    }
};

process.exit(await main());