import {promises as fs} from 'node:fs';
import {createReadStream, existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import path from 'node:path';
import type {RedactionHit} from './Privacy.js';

/**
 * DSGVO Layer 4: persistent audit log of every external LLM call.
 * Append-only JSONL — one entry per line, never edited in place. The
 * preview modal (Layer 3.5) asks the user *before* the call; this log
 * tells them *what actually happened* afterwards.
 *
 * One entry per LLM-touching operation against a non-local provider:
 *   - chat / summarize / compile / research
 *   - relink only when it actually invoked the LLM (some paths fall
 *     back to deterministic ranking)
 *
 * Local providers (Ollama loopback, RFC1918) are NOT logged — nothing
 * leaves the host, so there's nothing to audit from a DSGVO angle.
 *
 * Storage strategy:
 *   - JSONL because it's append-friendly (no file lock contention with
 *     in-flight writes), trivially parseable line-by-line, and the
 *     file can be tail'd / grep'd from a terminal for ad-hoc audits.
 *   - Default location is a hidden vault sidecar
 *     `<vault>/.synaipse-audit.jsonl` (skipped by the walker like
 *     `.synaipse-index.json` and `.synaipse-chats/`).
 *   - No rotation yet — if the file balloons we add `.synaipse-audit-
 *     <yyyy-mm>.jsonl` rotation as a follow-up. Typical user has
 *     dozens of chat turns per day, so a multi-year file is still
 *     under a few MB.
 *
 * Reads stream the file line-by-line so we don't load the whole log
 * into memory for the UI (`/api/audit` only ever needs the last N).
 * Newest entries are at the bottom — the read helper reverses so the
 * UI gets latest-first by default.
 */

export interface AuditEntry {
    /** Unix epoch ms when the call started. */
    ts: number;
    /** Provider identifier: 'claude-shell' | 'anthropic' | 'ollama' | 'openai' | … */
    provider: string;
    /** Whether the provider is local (loopback/RFC1918) or external. Local entries are NOT logged but we keep the field for forward-compatibility. */
    providerKind: 'local' | 'external';
    /** Which LLM touchpoint produced this entry. */
    kind: 'chat' | 'summarize' | 'compile' | 'relink' | 'research';
    /** Note IDs that made it into the LLM context after Layer 2 filtering. */
    noteIds: string[];
    /** Per-kind redaction counts from Layer 3 (already aggregated). */
    redactions: RedactionHit[];
    /** Notes blocked by Layer 2 (path/tag/frontmatter marker). Only set when > 0. */
    filteredPrivate?: number;
    /** First 200 chars of the question/prompt — only kept for chat/research where a user question exists. */
    question?: string;
    /** Token counts when the provider reports them. */
    tokens?: {input?: number; output?: number; total?: number};
    /** Wall time of the call in ms. */
    durationMs?: number;
}

export class AuditLog {
    public constructor(private readonly filePath: string) {}

    /**
     * Append a single entry. Creates the file (and parent dir) on first
     * write. Atomic per-line by virtue of `appendFile` flushing a single
     * write syscall for small payloads — concurrent appends from the
     * same Node process will interleave correctly.
     */
    public async append(entry: AuditEntry): Promise<void> {
        await fs.mkdir(path.dirname(this.filePath), {recursive: true});
        const line = JSON.stringify(entry) + '\n';
        await fs.appendFile(this.filePath, line, 'utf8');
    }

    /**
     * Stream-read all entries matching the filter. Newest-first.
     * `limit` caps the result set at N entries from the tail (newest);
     * `afterTs` excludes anything older-or-equal (cursor pagination).
     * Missing file → empty result (haven't logged anything yet).
     */
    public async read(opts: {
        limit?: number;
        afterTs?: number;
        provider?: string;
        kind?: AuditEntry['kind'];
    } = {}): Promise<AuditEntry[]> {
        if (!existsSync(this.filePath)) return [];

        const out: AuditEntry[] = [];
        const stream = createReadStream(this.filePath, {encoding: 'utf8'});
        const rl = createInterface({input: stream, crlfDelay: Infinity});

        for await (const line of rl) {
            if (line.length === 0) continue;
            let entry: AuditEntry;
            try {
                entry = JSON.parse(line) as AuditEntry;
            } catch {
                // Skip malformed lines instead of failing the whole read —
                // a partial-write or external editor mishap shouldn't bring
                // the UI down.
                continue;
            }

            if (opts.afterTs !== undefined && entry.ts <= opts.afterTs) continue;
            if (opts.provider !== undefined && entry.provider !== opts.provider) continue;
            if (opts.kind !== undefined && entry.kind !== opts.kind) continue;

            out.push(entry);
        }

        out.reverse();
        if (opts.limit !== undefined && opts.limit > 0) {
            return out.slice(0, opts.limit);
        }
        return out;
    }

    /**
     * Total entry count. Cheap-ish: walks the file once line-by-line.
     * Used by the UI footer ("128 external calls logged") without
     * loading all entries.
     */
    public async count(): Promise<number> {
        if (!existsSync(this.filePath)) return 0;
        const stream = createReadStream(this.filePath, {encoding: 'utf8'});
        const rl = createInterface({input: stream, crlfDelay: Infinity});
        let n = 0;
        for await (const line of rl) {
            if (line.length > 0) n++;
        }
        return n;
    }
}