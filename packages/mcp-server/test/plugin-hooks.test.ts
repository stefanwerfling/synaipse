import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * Plan P8 S8: the synaipse-memory plugin hooks (bash + jq). Each test runs
 * the real scripts against a throwaway project dir; the primer refresh
 * points at a dead port so nothing leaves the machine.
 */

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../plugins/synaipse-memory/hooks');
const hasJq = spawnSync('jq', ['--version']).status === 0;

let projectDir: string;
const SID = 'sess-1';

const hook = (name: string, payload: Record<string, unknown>, env: Record<string, string> = {}): string => {
    const result = spawnSync('bash', [path.join(HOOKS, name)], {
        input: JSON.stringify({session_id: SID, cwd: projectDir, ...payload}),
        env: {PATH: process.env.PATH ?? '', HOME: projectDir, CLAUDE_PROJECT_DIR: projectDir, SYNAIPSE_WEB_API_PORT: '9', ...env},
        encoding: 'utf8'
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
};

const lines = async (): Promise<Array<Record<string, unknown>>> =>
    (await readFile(path.join(projectDir, '.synaipse-sessions', `${SID}.jsonl`), 'utf8'))
        .trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

const meta = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(path.join(projectDir, '.synaipse-sessions', `${SID}.meta.json`), 'utf8')) as Record<string, unknown>;

const mcpResult = (data: unknown) => [{type: 'text', text: JSON.stringify(data)}];

beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'synaipse hooks '));
});

afterEach(async () => {
    await rm(projectDir, {recursive: true, force: true});
});

describe.skipIf(!hasJq)('synaipse-memory plugin hooks', () => {
    it('records the project as the sanitised folder name', async () => {
        hook('session-start.sh', {source: 'startup'});
        expect((await meta()).project).toMatch(/^synaipse-hooks-[A-Za-z0-9]+$/);
    });

    it('logs Synaipse calls with op, write flag and note ids, whichever server prefix', async () => {
        hook('session-start.sh', {source: 'startup'});
        hook('post-tool.sh', {
            tool_name: 'mcp__plugin_synaipse-memory_synaipse__synaipse_search',
            tool_input: {query: 'redis cache'},
            tool_response: mcpResult({hits: [{noteId: 'Memory/p/a.md'}, {noteId: 'Memory/p/b.md'}]})
        });
        hook('post-tool.sh', {
            tool_name: 'mcp__synaipse__synaipse_write_note',
            tool_input: {path: 'decisions/x.md', content: '...'},
            tool_response: {content: mcpResult({id: 'Memory/p/decisions/x.md', hash: 'h'})}
        });

        const synaipse = (await lines()).filter((l) => l.kind === 'synaipse');
        expect(synaipse).toEqual([
            expect.objectContaining({op: 'search', write: false, notes: ['Memory/p/a.md', 'Memory/p/b.md'], query: 'redis cache'}),
            expect.objectContaining({op: 'write_note', write: true, notes: ['Memory/p/decisions/x.md', 'decisions/x.md']})
        ]);

        hook('session-end.sh', {});
        expect(await meta()).toMatchObject({synaipse_writes: 1, synaipse_notes_used: ['Memory/p/a.md', 'Memory/p/b.md', 'Memory/p/decisions/x.md', 'decisions/x.md']});
    });

    it('nudges once when code was edited and nothing saved', async () => {
        hook('session-start.sh', {source: 'startup'});
        for (let i = 0; i < 3; i++) {
            hook('post-tool.sh', {tool_name: 'Edit', tool_input: {file_path: `/x/${i}.ts`}, tool_response: 'ok'});
        }

        const first = JSON.parse(hook('stop.sh', {transcript_path: '/t'})) as {decision: string; reason: string};
        expect(first.decision).toBe('block');
        expect(first.reason).toContain('3 edits');
        expect(hook('stop.sh', {transcript_path: '/t', stop_hook_active: true})).toBe('');
        expect(hook('stop.sh', {transcript_path: '/t'})).toBe('');
        expect((await meta()).nudged_at).toEqual(expect.any(String));
    });

    it('does not nudge after a save, below the edit threshold or when turned off', async () => {
        hook('session-start.sh', {source: 'startup'});
        hook('post-tool.sh', {tool_name: 'Edit', tool_input: {file_path: '/x/a.ts'}, tool_response: 'ok'});
        expect(hook('stop.sh', {})).toBe('');

        for (let i = 0; i < 3; i++) hook('post-tool.sh', {tool_name: 'Write', tool_input: {file_path: `/x/${i}.ts`}, tool_response: 'ok'});
        expect(hook('stop.sh', {}, {SYNAIPSE_STOP_NUDGE: '0'})).toBe('');

        hook('post-tool.sh', {tool_name: 'mcp__synaipse__synaipse_remember', tool_input: {text: 'x'}, tool_response: mcpResult({noteId: 'Memory/p/inbox/d.md'})});
        expect(hook('stop.sh', {})).toBe('');
    });

    it('ships a plugin .mcp.json that sends the project dir', async () => {
        const config = JSON.parse(await readFile(path.join(HOOKS, '..', '.mcp.json'), 'utf8')) as {mcpServers: {synaipse: {url: string; headers: Record<string, string>}}};
        expect(config.mcpServers.synaipse.url).toBe('http://localhost:${SYNAIPSE_WEB_API_PORT:-3001}/mcp/${SYNAIPSE_PROJECT:-}');
        expect(config.mcpServers.synaipse.headers['X-Synaipse-Project-Dir']).toBe('${CLAUDE_PROJECT_DIR}');
    });
});
