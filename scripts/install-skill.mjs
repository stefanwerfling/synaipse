#!/usr/bin/env node
// Installer for the Synaipse MCP server across the assistants we know speak
// MCP. Defaults to the HTTP transport that the web server already exposes
// at /mcp; falls back to stdio for setups that don't want the web process
// running.
//
//   npm run install-skill                 # interactive menu
//   npm run install-skill -- claude-code  # ./.mcp.json for this project (/mcp/<project>)
//   npm run install-skill -- claude-code --user   # ~/.claude.json, no project in the URL
//   npm run install-skill -- claude-code --project=kavula
//   npm run install-skill -- cursor       # workspace .cursor/mcp.json
//   npm run install-skill -- cursor --global
//   npm run install-skill -- all
//   npm run install-skill -- claude-code --transport=stdio
//   npm run install-skill -- claude-code --dry-run

import {execSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const mcpServerEntry = path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'Index.js');

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
    const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (hit === undefined) return fallback;
    if (hit.includes('=')) return hit.split('=', 2)[1];
    return true;
};

const isDryRun = flag('dry-run') === true;
const transport = flag('transport', 'http');
const port = Number.parseInt(flag('port', '3001'), 10);
const serverName = flag('server-name', 'synaipse');
const useGlobal = flag('global') === true;
const userScope = flag('user') === true;

// Same rule as the MCP server and the plugin's SessionStart hook: the
// folder name, characters outside [A-Za-z0-9_.-] replaced by "-".
const projectOf = (dir) => path.basename(dir).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
const projectFlag = flag('project');
if (projectFlag !== undefined && (projectFlag === true || !/^[A-Za-z0-9_.-]+$/.test(projectFlag))) {
    console.error('--project needs a name of letters, digits, ".", "_" or "-"');
    process.exit(2);
}

const positional = args.filter((a) => !a.startsWith('-'));
const action = positional[0] ?? 'menu';

/**
 * `project`: the MCP URL gets the project segment (/mcp/<project>), so
 * remember, log_session and relative write paths land in that project.
 * Only for configs that belong to one project (workspace files) or when
 * --project is given; a user-wide config without it stays project-less.
 */
const mcpEntry = (project) => {
    if (transport === 'stdio') {
        return {
            type: 'stdio',
            command: 'node',
            args: ['--enable-source-maps', mcpServerEntry],
            env: {SYNAIPSE_MCP_TRANSPORT: 'stdio', ...(project !== undefined ? {SYNAIPSE_PROJECT: project} : {})}
        };
    }

    return {
        type: 'http',
        url: `http://localhost:${port}/mcp${project !== undefined ? `/${encodeURIComponent(project)}` : ''}`
    };
};

/** The project for a workspace-scoped config: --project, else the current folder. */
const workspaceProject = () => projectFlag ?? (projectOf(process.cwd()) || undefined);

const detect = (binary) => {
    try {
        execSync(`command -v ${binary}`, {stdio: 'ignore'});
        return true;
    } catch {
        return false;
    }
};

const readJsonSafe = (file) => {
    if (!existsSync(file)) return null;
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        console.warn(`! could not parse ${file}: ${error.message}`);
        return null;
    }
};

const backup = (file) => {
    if (!existsSync(file)) return;
    const bak = `${file}.bak.${Date.now()}`;
    writeFileSync(bak, readFileSync(file));
    console.log(`  backup: ${bak}`);
};

const ensureDir = (file) => {
    mkdirSync(path.dirname(file), {recursive: true});
};

const mergeMcpServers = (existing, name, entry) => {
    const base = existing === null ? {} : existing;
    const servers = {...(base.mcpServers ?? {}), [name]: entry};
    return {...base, mcpServers: servers};
};

const writeConfig = (file, next) => {
    if (isDryRun) {
        console.log(`  dry-run: would write ${file}`);
        console.log(JSON.stringify(next, null, 2));
        return;
    }

    backup(file);
    ensureDir(file);
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`  wrote: ${file}`);
};

const TARGETS = {
    'claude-code': {
        label: userScope ? 'Claude Code (user)' : 'Claude Code (project .mcp.json)',
        detect: () => detect('claude'),
        path: () => userScope ? path.join(os.homedir(), '.claude.json') : path.join(process.cwd(), '.mcp.json'),
        project: () => userScope ? projectFlag : workspaceProject(),
        install(entry) {
            const file = this.path();
            const existing = readJsonSafe(file);
            const next = mergeMcpServers(existing, serverName, entry);
            writeConfig(file, next);
            console.log('  note: the synaipse-memory plugin registers this server too (with the project from the');
            console.log('        repo folder). Use one of the two, otherwise every tool is listed twice.');
        }
    },
    cursor: {
        label: useGlobal ? 'Cursor (global)' : 'Cursor (workspace)',
        detect: () => detect('cursor') || existsSync(path.join(os.homedir(), '.cursor')),
        path: () => useGlobal
            ? path.join(os.homedir(), '.cursor', 'mcp.json')
            : path.join(process.cwd(), '.cursor', 'mcp.json'),
        project: () => useGlobal ? projectFlag : workspaceProject(),
        install(entry) {
            const file = this.path();
            const existing = readJsonSafe(file);
            const next = mergeMcpServers(existing, serverName, entry);
            writeConfig(file, next);
        }
    },
    cline: {
        label: 'Cline (VS Code)',
        detect: () => existsSync(path.join(os.homedir(), '.vscode')),
        path: () => path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
        install(entry) {
            const file = this.path();
            const existing = readJsonSafe(file);
            const next = mergeMcpServers(existing, serverName, entry);
            writeConfig(file, next);
        }
    },
    zed: {
        label: 'Zed AI',
        detect: () => detect('zed'),
        path: () => path.join(os.homedir(), '.config', 'zed', 'settings.json'),
        install(entry) {
            const file = this.path();
            const existing = readJsonSafe(file) ?? {};
            const context_servers = {
                ...(existing.context_servers ?? {}),
                [serverName]: entry.type === 'http'
                    ? {source: 'custom', url: entry.url}
                    : {source: 'custom', command: entry.command, args: entry.args}
            };
            const next = {...existing, context_servers};
            writeConfig(file, next);
        }
    },
    gemini: {
        label: 'Gemini CLI (manual)',
        detect: () => detect('gemini'),
        path: () => null,
        install() {
            console.log(`  Gemini CLI doesn't natively support MCP yet (as of this build).`);
            console.log(`  Workaround: run the Synaipse MCP server in stdio mode and pipe`);
            console.log(`  Gemini's tool calls to it via a wrapper. See docs/skill-install.md`);
            console.log(`  in this repo for the boilerplate.`);
        }
    },
    codex: {
        label: 'Codex (manual)',
        detect: () => detect('codex'),
        path: () => null,
        install() {
            console.log(`  Codex uses AGENTS.md for instructions, not MCP. Drop the`);
            console.log(`  generated AGENTS.md template (also from docs/skill-install.md)`);
            console.log(`  into your project root to give it Synaipse-awareness.`);
        }
    }
};

const showMenu = () => {
    console.log('Synaipse skill installer');
    console.log('');
    console.log(`Transport: ${transport}${transport === 'http' ? ` (http://localhost:${port}/mcp)` : ''}`);
    console.log(`Server name: ${serverName}`);
    console.log('');

    const detected = [];
    const missing = [];

    for (const [key, target] of Object.entries(TARGETS)) {
        const found = target.detect();
        if (found) detected.push({key, target});
        else missing.push({key, target});
    }

    if (detected.length === 0) {
        console.log('No supported assistants detected on PATH.');
    } else {
        console.log('Detected assistants:');
        for (const {key, target} of detected) {
            console.log(`  ${key.padEnd(14)} ${target.label}`);
        }
    }

    if (missing.length > 0) {
        console.log('');
        console.log('Not detected (still installable if you know the path):');
        for (const {key, target} of missing) {
            console.log(`  ${key.padEnd(14)} ${target.label}`);
        }
    }

    console.log('');
    console.log('Run one of:');
    console.log('  npm run install-skill -- <target>');
    console.log('  npm run install-skill -- all');
    console.log('  npm run install-skill -- <target> --transport=stdio');
    console.log('  npm run install-skill -- <target> --dry-run');
    console.log('');
    console.log('  npm run install-skill -- <target> --project=<name>');
    console.log('');
    console.log('Targets: claude-code (--user), cursor (--global), cline, zed, gemini, codex, all');
    console.log('claude-code and cursor write the config of the current folder with /mcp/<folder name>;');
    console.log('--user / --global write the user-wide config (project only with --project).');
    console.log('For Claude Code the synaipse-memory plugin is the alternative: it registers the');
    console.log('server itself and takes the project from the repo folder.');
};

const install = (key) => {
    const target = TARGETS[key];
    if (target === undefined) {
        console.error(`unknown target: ${key}`);
        process.exit(2);
    }

    const project = target.project?.() ?? projectFlag;
    console.log(`> ${target.label}${project !== undefined ? ` — project ${project}` : ''}`);
    target.install(mcpEntry(project));
};

if (action === 'menu') {
    showMenu();
    process.exit(0);
}

if (action === 'all') {
    for (const key of Object.keys(TARGETS)) {
        install(key);
    }
    process.exit(0);
}

install(action);