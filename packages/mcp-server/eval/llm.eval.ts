import {describe, expect, it} from 'vitest';
import {mkdir, mkdtemp, readFile, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {SynaipseService} from '@synaipse/service';
import {buildTools} from '../src/Tools.js';
import {buildMcpServer} from '../src/Server.js';
import {EventPublisher} from '../src/EventPublisher.js';
import {EVAL_DRAFTS, EVAL_NOTES, EVAL_QUESTIONS, type EvalDraft, type EvalNote, type EvalQuestion} from './fixture.js';
import {regressions, type DedupeSummary, type EvalReport, type QuestionResult, type Summary} from './Report.js';

/**
 * LLM-usability eval (plan P8 / B7). A scripted agent answers each fixture
 * question the way the server instructions tell an LLM to: one
 * synaipse_search (limit 5), then synaipse_read_note on the top hit (only
 * its matching section when the hit names one). It
 * measures whether the right note comes first and what that costs in
 * tokens, plus the fixed context cost (tool list, instructions, prime).
 *
 * Results are compared with eval/baseline.json; a regression fails the
 * run. After an intended change: EVAL_UPDATE_BASELINE=1 npm run eval.
 * Embeddings are off (offline, deterministic), so this measures fulltext,
 * title and graph signals plus everything the response format adds.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, 'baseline.json');
const PROJECT = 'kestrel';
const SEARCH_LIMIT = 5;

/** Rough token count; stable across runs, which is what a comparison needs. */
const tokens = (text: string): number => Math.ceil(text.length / 4);

const yamlValue = (v: unknown): string => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v));

const seedVault = async (root: string, notes: readonly EvalNote[]): Promise<void> => {
    for (const note of notes) {
        const abs = path.join(root, note.path);
        await mkdir(path.dirname(abs), {recursive: true});
        const fm: Record<string, unknown> = {title: note.title, ...(note.tags ? {tags: note.tags} : {}), ...note.fm};
        const lines = Object.entries(fm).map(([k, v]) => `${k}: ${yamlValue(v)}`);
        await writeFile(abs, `---\n${lines.join('\n')}\n---\n\n# ${note.title}\n\n${note.body}\n`, 'utf8');

        const updated = typeof note.fm?.updated === 'string' ? new Date(`${note.fm.updated}T12:00:00Z`) : new Date('2025-01-01T12:00:00Z');
        await utimes(abs, updated, updated);
    }
};

const config = (vaultPath: string) => ({
    vaultPath,
    indexCachePath: path.join(vaultPath, '.cache.json'),
    chatStoreDir: path.join(vaultPath, '..', 'chats'),
    auditLogPath: path.join(vaultPath, '.audit.jsonl'),
    schedulesPath: path.join(vaultPath, '..', 'schedules.json'),
    embeddings: {provider: 'none' as const},
    qdrant: {url: 'http://127.0.0.1:9', collection: 'eval'},
    server: {name: 'synaipse-eval', version: '0.0.0'},
    web: {port: 0}
});

const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string =>
    (result.content as Array<{type: string; text?: string}>).map((c) => c.text ?? '').join('\n');

const answer = async (client: Client, q: EvalQuestion): Promise<QuestionResult> => {
    const search = textOf(await client.callTool({name: 'synaipse_search', arguments: {query: q.query, limit: SEARCH_LIMIT}}));
    const hitList = (JSON.parse(search) as {hits?: Array<{noteId: string; section?: string}>}).hits ?? [];
    const hits = hitList.map((h) => h.noteId);

    const best = q.relevant[0] as string;
    const relevant = new Set(q.relevant);
    const firstRelevant = hits.findIndex((id) => relevant.has(id));
    const rank = firstRelevant + 1;
    const found = q.relevant.filter((id) => hits.includes(id)).length;

    const bestIndex = hits.indexOf(best);
    const outdatedAbove = (q.outdated ?? []).some((id) => {
        const i = hits.indexOf(id);
        return i !== -1 && (bestIndex === -1 || i < bestIndex);
    });

    // Like the tool description says: read only the matching section when the hit names one.
    const top = hitList[0];
    const readTokens = top === undefined
        ? 0
        : tokens(textOf(await client.callTool({name: 'synaipse_read_note', arguments: {id: top.noteId, ...(top.section !== undefined ? {section: top.section} : {})}})));

    return {
        id: q.id,
        category: q.category,
        rank,
        recallAt5: found / q.relevant.length,
        outdatedAbove,
        searchTokens: tokens(search),
        readTokens
    };
};

/** Write the draft like an agent would and return the notes the duplicate check named. */
const attemptWrite = async (client: Client, draft: EvalDraft): Promise<string[]> => {
    const result = draft.tool === 'remember'
        ? await client.callTool({name: 'synaipse_remember', arguments: {text: draft.content}})
        : await client.callTool({name: 'synaipse_write_note', arguments: {path: `eval/${draft.id}.md`, content: draft.content, frontmatter: {title: draft.title}}});
    const parsed = JSON.parse(textOf(result)) as {possibleDuplicates?: Array<{id: string}>};
    return (parsed.possibleDuplicates ?? []).map((d) => d.id);
};

const summarizeDedupe = (flagged: Record<string, string[]>): DedupeSummary => {
    const dups = EVAL_DRAFTS.filter((d) => d.duplicateOf.length > 0);
    const fresh = EVAL_DRAFTS.filter((d) => d.duplicateOf.length === 0);
    const round = (x: number): number => Math.round(x * 1000) / 1000;

    return {
        drafts: EVAL_DRAFTS.length,
        recall: round(dups.filter((d) => (flagged[d.id] ?? []).some((id) => d.duplicateOf.includes(id))).length / Math.max(1, dups.length)),
        falseAlarms: round(fresh.filter((d) => (flagged[d.id] ?? []).length > 0).length / Math.max(1, fresh.length)),
        flagged
    };
};

const summarize = (results: readonly QuestionResult[], questions: readonly EvalQuestion[]): Summary => {
    const n = results.length;
    const withOutdated = results.filter((r) => (questions.find((q) => q.id === r.id)?.outdated ?? []).length > 0);
    const round = (x: number): number => Math.round(x * 1000) / 1000;

    return {
        questions: n,
        hitAt1: round(results.filter((r) => r.rank === 1).length / n),
        recallAt5: round(results.reduce((s, r) => s + r.recallAt5, 0) / n),
        mrr: round(results.reduce((s, r) => s + (r.rank > 0 ? 1 / r.rank : 0), 0) / n),
        outdatedAbove: withOutdated.length === 0 ? 0 : round(withOutdated.filter((r) => r.outdatedAbove).length / withOutdated.length),
        tokensPerQuestion: Math.round(results.reduce((s, r) => s + r.searchTokens + r.readTokens, 0) / n)
    };
};

const table = (report: EvalReport, base: EvalReport | null): string => {
    const row = (name: string, s: Summary, b?: Summary): string => {
        const d = (k: keyof Summary): string => {
            const v = String(s[k]);
            if (b === undefined || b[k] === s[k]) return v;
            return `${v} (${b[k]})`;
        };
        return `| ${name.padEnd(10)} | ${String(s.questions).padStart(3)} | ${d('hitAt1')} | ${d('recallAt5')} | ${d('mrr')} | ${d('outdatedAbove')} | ${d('tokensPerQuestion')} |`;
    };

    return [
        '| category   |   N | hit@1 | R@5 | MRR | outdated above | tokens/question |',
        '|------------|----:|-------|-----|-----|----------------|-----------------|',
        row('overall', report.overall, base?.overall),
        ...Object.entries(report.byCategory).map(([c, s]) => row(c, s, base?.byCategory[c]))
    ].join('\n');
};

describe('LLM usability eval', () => {
    it('answers the fixture questions over MCP without regressing against the baseline', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'synaipse-eval-'));
        let run = 0;

        /**
         * A fresh vault and server per question: reads count as accesses and
         * make the read notes graph seeds, so a shared session would let one
         * question's answer shift the ranking of the next.
         */
        const session = async <T>(fn: (client: Client) => Promise<T>): Promise<T> => {
            const vault = path.join(root, `vault-${run++}`);
            await mkdir(vault);
            await seedVault(vault, EVAL_NOTES);
            const cfg = config(vault);
            const service = new SynaipseService(cfg);
            await service.start();

            const server = buildMcpServer(cfg, buildTools(service), new EventPublisher(null), PROJECT, {project: PROJECT});
            const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
            const client = new Client({name: 'eval', version: '0.0.0'});
            await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

            try {
                return await fn(client);
            } finally {
                await client.close();
                await service.stop();
            }
        };

        try {
            const results: QuestionResult[] = [];
            for (const q of EVAL_QUESTIONS) results.push(await session((client) => answer(client, q)));
            const flagged: Record<string, string[]> = {};
            for (const draft of EVAL_DRAFTS) flagged[draft.id] = await session((client) => attemptWrite(client, draft));
            const context = await session(async (client) => ({
                toolListTokens: tokens(JSON.stringify((await client.listTools()).tools)),
                instructionsTokens: tokens(client.getInstructions() ?? ''),
                primeTokens: tokens(textOf(await client.callTool({name: 'synaipse_prime', arguments: {}})))
            }));

            const categories = [...new Set(EVAL_QUESTIONS.map((q) => q.category))];
            const report: EvalReport = {
                fixture: {notes: EVAL_NOTES.length, questions: EVAL_QUESTIONS.length},
                context,
                dedupe: summarizeDedupe(flagged),
                overall: summarize(results, EVAL_QUESTIONS),
                byCategory: Object.fromEntries(categories.map((c) => [c, summarize(results.filter((r) => r.category === c), EVAL_QUESTIONS)])),
                questions: results
            };

            const base = await readFile(BASELINE, 'utf8').then((raw) => JSON.parse(raw) as EvalReport, () => null);
            const misses = results.filter((r) => r.rank !== 1).map((r) => `${r.id}${r.rank === 0 ? '✗' : `@${r.rank}`}${r.outdatedAbove ? '!' : ''}`);

            process.stdout.write([
                '',
                `Synaipse LLM eval: ${report.fixture.questions} questions, ${report.fixture.notes} notes (baseline values in brackets)`,
                '',
                table(report, base),
                '',
                `context tokens: tool list ${report.context.toolListTokens}, instructions ${report.context.instructionsTokens}, prime ${report.context.primeTokens}`,
                `duplicate check: recall ${report.dedupe!.recall}${base?.dedupe ? ` (${base.dedupe.recall})` : ''}, false alarms ${report.dedupe!.falseAlarms}${base?.dedupe ? ` (${base.dedupe.falseAlarms})` : ''}; flagged ${Object.entries(flagged).map(([id, ids]) => `${id}:${ids.length > 0 ? ids.map((x) => x.split('/').pop()).join('+') : '-'}`).join(' ')}`,
                `not first (rank, ✗ = missing, ! = outdated above): ${misses.join(' ') || 'none'}`,
                ''
            ].join('\n') + '\n');

            if (process.env.EVAL_UPDATE_BASELINE === '1' || base === null) {
                await writeFile(BASELINE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
                process.stdout.write(`baseline written → ${BASELINE}\n\n`);
                return;
            }

            expect(regressions(base, report), 'regressions against eval/baseline.json').toEqual([]);
        } finally {
            await rm(root, {recursive: true, force: true});
        }
    }, 120_000);
});
