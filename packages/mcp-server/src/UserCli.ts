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
    label?: string;
    read: boolean;
    write: boolean;
    prefix: string[];
    tool: string[];
    expiresInDays?: number;
}

const parseFlags = (argv: readonly string[]): ParsedFlags => {
    const out: ParsedFlags = {read: false, write: false, prefix: [], tool: []};

    for (const arg of argv) {
        if (arg.startsWith('--label=')) {
            out.label = arg.slice('--label='.length);
        } else if (arg === '--read') {
            out.read = true;
        } else if (arg === '--write') {
            out.write = true;
        } else if (arg.startsWith('--prefix=')) {
            out.prefix.push(arg.slice('--prefix='.length));
        } else if (arg.startsWith('--tool=')) {
            out.tool.push(arg.slice('--tool='.length));
        } else if (arg.startsWith('--expires-in-days=')) {
            const raw = arg.slice('--expires-in-days='.length);
            const parsed = Number.parseFloat(raw);
            if (Number.isFinite(parsed) && parsed > 0) {
                out.expiresInDays = parsed;
            }
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
        process.stderr.write('usage: npm run user <create|list|revoke|rotate|import-yaml> [flags]\n');
        return 2;
    }

    const config = loadConfigFromEnv();

    if (config.mode !== 'server') {
        process.stderr.write(
            'user CLI requires SYNAIPSE_MODE=server (the users table lives in MariaDB). '
            + 'Local mode keeps using config.server.tokens in yaml.\n'
        );
        return 2;
    }

    if (config.mariadb === undefined) {
        process.stderr.write('config.mariadb is missing — check your env / config.\n');
        return 2;
    }

    const bundle = await createServerAdapters(config.mariadb);

    try {
        if (sub === 'create') {
            const flags = parseFlags(args.slice(1));
            if (flags.label === undefined || flags.label.length === 0) {
                process.stderr.write('user create requires --label=<name>\n');
                return 2;
            }
            if (!flags.read && !flags.write) {
                process.stderr.write('user create requires at least one of --read / --write\n');
                return 2;
            }

            const expiresAt = flags.expiresInDays !== undefined
                ? Date.now() + flags.expiresInDays * 86_400_000
                : null;

            const {user, plainToken} = await bundle.users.createUser({
                label: flags.label,
                read: flags.read,
                write: flags.write,
                pathPrefixes: flags.prefix,
                tools: flags.tool,
                expiresAt
            });

            log(`[user] created "${user.label}" (id=${user.id}, hint=${user.tokenHint})`);
            log(`[user] scope: read=${user.read} write=${user.write} prefixes=${user.pathPrefixes.length === 0 ? '-' : user.pathPrefixes.join(',')} tools=${user.tools.length === 0 ? '-' : user.tools.join(',')}`);
            log(`[user] expires: ${user.expiresAt !== null ? new Date(user.expiresAt).toISOString() : 'never'}`);
            log('[user] token (shown ONCE — store it now):');
            process.stdout.write(`${plainToken}\n`);
            return 0;
        }

        if (sub === 'list') {
            const users = await bundle.users.listUsers();
            if (users.length === 0) {
                log('[user] no users in this vault');
                return 0;
            }

            const now = Date.now();
            for (const u of users) {
                // Priority: revoked > expired > active. A user can be both
                // revoked AND expired — REVOKED wins because it's the more
                // recent operator action and bears intent.
                const status = u.revokedAt !== null
                    ? 'REVOKED'
                    : (u.expiresAt !== null && u.expiresAt <= now ? 'EXPIRED' : 'active');
                const lastUsed = u.lastUsedAt !== null ? new Date(u.lastUsedAt).toISOString() : 'never';
                const expires = u.expiresAt !== null ? new Date(u.expiresAt).toISOString() : 'never';
                const scope = `r=${u.read ? 'y' : 'n'} w=${u.write ? 'y' : 'n'}`;
                const restrict = [
                    u.pathPrefixes.length > 0 ? `paths=${u.pathPrefixes.join(',')}` : null,
                    u.tools.length > 0 ? `tools=${u.tools.join(',')}` : null
                ].filter((s): s is string => s !== null).join(' ');
                log(`[user] ${status.padEnd(7)} #${u.id} ${u.label} (hint=${u.tokenHint}) ${scope}${restrict.length > 0 ? ' ' + restrict : ''} last=${lastUsed} expires=${expires}`);
            }
            return 0;
        }

        if (sub === 'revoke') {
            const flags = parseFlags(args.slice(1));
            if (flags.label === undefined || flags.label.length === 0) {
                process.stderr.write('user revoke requires --label=<name>\n');
                return 2;
            }

            const revoked = await bundle.users.revokeByLabel(flags.label);
            if (!revoked) {
                log(`[user] no active user with label "${flags.label}"`);
                return 1;
            }
            log(`[user] revoked "${flags.label}"`);
            return 0;
        }

        if (sub === 'rotate') {
            const flags = parseFlags(args.slice(1));
            if (flags.label === undefined || flags.label.length === 0) {
                process.stderr.write('user rotate requires --label=<name>\n');
                return 2;
            }

            const expiresAt = flags.expiresInDays !== undefined
                ? Date.now() + flags.expiresInDays * 86_400_000
                : null;

            const result = await bundle.users.rotateByLabel(flags.label, expiresAt);
            if (result === null) {
                log(`[user] no user with label "${flags.label}"`);
                return 1;
            }

            log(`[user] rotated "${result.user.label}" (id=${result.user.id}, new hint=${result.user.tokenHint})`);
            log(`[user] expires: ${result.user.expiresAt !== null ? new Date(result.user.expiresAt).toISOString() : 'never'}`);
            log('[user] new token (shown ONCE — store it now):');
            process.stdout.write(`${result.plainToken}\n`);
            return 0;
        }

        if (sub === 'import-yaml') {
            const yamlTokens = config.server.tokens;
            if (yamlTokens === undefined || yamlTokens.length === 0) {
                log('[user] no config.server.tokens entries to import');
                return 0;
            }

            let imported = 0;
            let failed = 0;

            for (const entry of yamlTokens) {
                const label = entry.label ?? `imported-${entry.token.slice(0, 8)}`;
                try {
                    // import-yaml seeds rows with the YAML scope but re-issues
                    // a fresh token — yaml stored plain tokens, we don't, so
                    // operators get a new bearer to deploy.
                    const {user, plainToken} = await bundle.users.createUser({
                        label,
                        read: entry.read === true,
                        write: entry.write === true,
                        pathPrefixes: entry.pathPrefixes ?? [],
                        tools: entry.tools ?? []
                    });
                    imported += 1;
                    log(`[user] imported "${user.label}" — NEW token:`);
                    process.stdout.write(`${plainToken}\n`);
                } catch (cause) {
                    failed += 1;
                    log(`[user] ! failed to import "${label}": ${String(cause)}`);
                }
            }

            log(`[user] import done — imported ${imported}, failed ${failed}`);
            return failed === 0 ? 0 : 1;
        }

        process.stderr.write(`unknown user subcommand: ${sub}\n`);
        return 2;
    } finally {
        await bundle.close();
    }
};

process.exit(await main());