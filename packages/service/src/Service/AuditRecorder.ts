import {createLogger} from '@synaipse/core';
import {getAuditTokenLabel} from '../AuditContext.js';
import type {AuditEntry, AuditLog} from '../AuditLog.js';
import type {LlmProvider} from '../Llm.js';

const log = createLogger('service');

export interface EmbedderAuditInfo {
    /** 'voyage' | 'ollama' | 'huggingface', or null when embeddings are off. */
    providerId: string | null;
    /** True iff embedder calls leave the host (voyage always; ollama with a non-loopback URL). */
    external: boolean;
}

/**
 * DSGVO Layer 4: the audit trail of calls that send vault content to an
 * external LLM or embedder. Local providers leave no entries. Writing
 * the log is best-effort: the call already happened, so an I/O error
 * here only warns.
 */
export class AuditRecorder {
    public constructor(
        private readonly auditLog: AuditLog,
        private readonly chatProvider: LlmProvider | null,
        private readonly embedder: EmbedderAuditInfo
    ) {}

    /** After an external LLM call has completed. */
    public async recordExternalCall(params: Omit<AuditEntry, 'ts' | 'provider' | 'providerKind'>): Promise<void> {
        const provider = this.chatProvider;
        if (provider === null || provider.isLocal()) return;

        const tokenLabel = getAuditTokenLabel();
        await this.append({
            ts: Date.now(),
            provider: provider.kind,
            providerKind: 'external',
            ...params,
            ...(tokenLabel !== undefined ? {tokenLabel} : {})
        });
    }

    /**
     * One semantic-search call against an external embedder. `embedCalls`
     * lets loop-heavy operations (suggestLinks embeds N samples) write a
     * single line instead of flooding the file.
     */
    public async recordExternalEmbed(params: {
        source: NonNullable<AuditEntry['embedSource']>;
        noteIds: string[];
        question?: string;
        embedCalls?: number;
        durationMs?: number;
    }): Promise<void> {
        if (!this.embedder.external || this.embedder.providerId === null) return;

        const tokenLabel = getAuditTokenLabel();
        await this.append({
            ts: Date.now(),
            provider: this.embedder.providerId,
            providerKind: 'external',
            kind: 'embed',
            noteIds: params.noteIds,
            redactions: [],
            embedSource: params.source,
            embedCalls: params.embedCalls ?? 1,
            ...(params.question !== undefined ? {question: params.question} : {}),
            ...(params.durationMs !== undefined ? {durationMs: params.durationMs} : {}),
            ...(tokenLabel !== undefined ? {tokenLabel} : {})
        });
    }

    private async append(entry: AuditEntry): Promise<void> {
        try {
            await this.auditLog.append(entry);
        } catch (cause) {
            log.warn('audit log append failed', {error: cause});
        }
    }

    /** Audit entries for the `/api/audit` UI; the filter goes 1:1 to the storage layer. */
    public async entries(opts: {
        limit?: number;
        afterTs?: number;
        provider?: string;
        kind?: AuditEntry['kind'];
        excludeKinds?: readonly AuditEntry['kind'][];
    } = {}): Promise<AuditEntry[]> {
        return this.auditLog.read(opts);
    }

    /** One page of audit entries, newest-first; see `AuditLog.page`. */
    public async page(opts: Parameters<AuditLog['page']>[0]): Promise<{entries: AuditEntry[]; nextBeforeLine: number | null}> {
        return this.auditLog.page(opts);
    }

    public async count(opts: {excludeKinds?: readonly AuditEntry['kind'][]} = {}): Promise<number> {
        return this.auditLog.count(opts);
    }
}
