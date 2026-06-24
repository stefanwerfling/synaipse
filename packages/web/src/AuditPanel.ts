import {api, type AuditEntry, type AuditKind} from './Api.js';
import {clear, el} from './Dom.js';

/**
 * DSGVO Layer 4 panel: shows the persistent audit log of every external
 * LLM call made by Synaipse. Each entry is one row with timestamp,
 * provider, kind, source-count, redaction-count; click to expand into
 * the full detail (note IDs, per-kind redaction breakdown, question if
 * any, duration).
 *
 * Local-provider calls are NOT in the log — they don't leave the host
 * so there's nothing to audit. Empty log on a fresh install or after
 * switching the chat provider to Ollama is the expected state.
 *
 * Filter bar (provider, kind) and a refresh button. No live updates yet
 * — refresh on tab switch or explicit button click. SSE could come
 * later if "chat happens often enough that the user has the audit tab
 * open while chatting" turns out to be a real workflow.
 */

const KIND_LABELS: Record<AuditKind, string> = {
    chat: 'Chat',
    summarize: 'Summarize',
    compile: 'Compile',
    relink: 'Relink',
    research: 'Research'
};

const formatTs = (ms: number): string => {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const formatDuration = (ms: number | undefined): string => {
    if (ms === undefined || ms < 0) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
};

const sumRedactions = (e: AuditEntry): number => e.redactions.reduce((a, r) => a + r.count, 0);

export class AuditPanel {
    public readonly element: HTMLElement;
    private readonly listHost: HTMLElement;
    private readonly emptyHost: HTMLElement;
    private readonly headStats: HTMLElement;
    private readonly providerFilter: HTMLSelectElement;
    private readonly kindFilter: HTMLSelectElement;
    private knownProviders = new Set<string>();

    public constructor() {
        this.element = el('div', {class: 'audit-panel'});

        const heading = el('div', {class: 'audit-head'},
            el('h2', {text: 'Audit Log'}),
            el('p', {class: 'audit-subtitle', text: 'DSGVO Layer 4 — alle externen LLM-Aufrufe (lokale Provider bleiben ungeloggt).'})
        );

        this.headStats = el('div', {class: 'audit-stats', text: ''});

        this.providerFilter = el('select', {
            class: 'audit-filter',
            on: {change: () => void this.refresh()}
        }) as HTMLSelectElement;
        this.providerFilter.appendChild(el('option', {attrs: {value: ''}, text: 'Alle Provider'}));

        this.kindFilter = el('select', {
            class: 'audit-filter',
            on: {change: () => void this.refresh()}
        }) as HTMLSelectElement;
        this.kindFilter.appendChild(el('option', {attrs: {value: ''}, text: 'Alle Aufrufe'}));
        for (const [k, label] of Object.entries(KIND_LABELS)) {
            this.kindFilter.appendChild(el('option', {attrs: {value: k}, text: label}));
        }

        const refreshBtn = el('button', {
            class: 'btn audit-refresh',
            attrs: {type: 'button'},
            text: 'Refresh',
            on: {click: () => void this.refresh()}
        });

        const filterBar = el('div', {class: 'audit-filter-bar'},
            this.kindFilter,
            this.providerFilter,
            refreshBtn,
            this.headStats
        );

        this.listHost = el('div', {class: 'audit-list'});
        this.emptyHost = el('div', {
            class: 'audit-empty',
            text: 'Noch keine externen LLM-Aufrufe geloggt. Wenn dein Chat-Provider lokal ist (Ollama), bleibt diese Seite leer — gewollt: nichts verlässt den Host, nichts zu auditieren.'
        });

        this.element.appendChild(heading);
        this.element.appendChild(filterBar);
        this.element.appendChild(this.listHost);
        this.element.appendChild(this.emptyHost);
    }

    public async onShow(): Promise<void> {
        await this.refresh();
    }

    private async refresh(): Promise<void> {
        const opts: {limit: number; provider?: string; kind?: AuditKind} = {limit: 200};
        const p = this.providerFilter.value;
        const k = this.kindFilter.value;
        if (p.length > 0) opts.provider = p;
        if (k.length > 0) opts.kind = k as AuditKind;

        let result;
        try {
            result = await api.audit(opts);
        } catch (e) {
            clear(this.listHost);
            this.emptyHost.style.display = 'none';
            this.listHost.appendChild(el('div', {
                class: 'audit-error',
                text: `Audit-Log laden fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`
            }));
            return;
        }

        this.refreshProviderOptions(result.entries);
        this.renderList(result.entries);
        this.headStats.textContent = result.total === 0
            ? ''
            : `${result.entries.length} angezeigt / ${result.total} gesamt`;
    }

    private refreshProviderOptions(entries: readonly AuditEntry[]): void {
        for (const e of entries) {
            if (!this.knownProviders.has(e.provider)) {
                this.knownProviders.add(e.provider);
                this.providerFilter.appendChild(el('option', {
                    attrs: {value: e.provider},
                    text: e.provider
                }));
            }
        }
    }

    private renderList(entries: readonly AuditEntry[]): void {
        clear(this.listHost);

        if (entries.length === 0) {
            this.emptyHost.style.display = '';
            return;
        }

        this.emptyHost.style.display = 'none';

        for (const e of entries) {
            this.listHost.appendChild(this.renderEntry(e));
        }
    }

    private renderEntry(e: AuditEntry): HTMLElement {
        const redactTotal = sumRedactions(e);
        const noteCount = e.noteIds.length;

        const head = el('div', {class: 'audit-entry-head'},
            el('span', {class: 'audit-entry-ts', text: formatTs(e.ts)}),
            el('span', {class: `audit-entry-kind audit-entry-kind-${e.kind}`, text: KIND_LABELS[e.kind]}),
            el('span', {class: 'audit-entry-provider', text: e.provider}),
            el('span', {class: 'audit-entry-counts'},
                el('span', {class: 'audit-pill', text: `${noteCount} ${noteCount === 1 ? 'Quelle' : 'Quellen'}`}),
                redactTotal > 0
                    ? el('span', {class: 'audit-pill audit-pill-redact', text: `${redactTotal} redacted`})
                    : el('span', {style: {display: 'none'}}),
                e.filteredPrivate !== undefined && e.filteredPrivate > 0
                    ? el('span', {class: 'audit-pill audit-pill-blocked', text: `${e.filteredPrivate} geblockt`})
                    : el('span', {style: {display: 'none'}}),
                el('span', {class: 'audit-entry-duration', text: formatDuration(e.durationMs)})
            )
        );

        const details = el('div', {class: 'audit-entry-details', style: {display: 'none'}});
        this.fillDetails(details, e);

        head.addEventListener('click', () => {
            details.style.display = details.style.display === 'none' ? '' : 'none';
        });

        const wrap = el('div', {class: 'audit-entry'},
            head,
            details
        );

        return wrap;
    }

    private fillDetails(host: HTMLElement, e: AuditEntry): void {
        clear(host);

        if (e.question !== undefined && e.question.length > 0) {
            host.appendChild(el('div', {class: 'audit-detail-row'},
                el('span', {class: 'audit-detail-label', text: 'Frage'}),
                el('span', {class: 'audit-detail-value audit-detail-question', text: e.question})
            ));
        }

        if (e.noteIds.length > 0) {
            const list = el('span', {class: 'audit-detail-value'});
            for (let i = 0; i < e.noteIds.length; i++) {
                if (i > 0) list.appendChild(el('span', {text: ' · '}));
                list.appendChild(el('code', {text: e.noteIds[i] ?? ''}));
            }
            host.appendChild(el('div', {class: 'audit-detail-row'},
                el('span', {class: 'audit-detail-label', text: 'Note-IDs'}),
                list
            ));
        }

        if (e.redactions.length > 0) {
            const breakdown = e.redactions
                .map((r) => `${r.count} ${r.kind}`)
                .join(', ');
            host.appendChild(el('div', {class: 'audit-detail-row'},
                el('span', {class: 'audit-detail-label', text: 'Redaktionen'}),
                el('span', {class: 'audit-detail-value', text: breakdown})
            ));
        }

        if (e.filteredPrivate !== undefined && e.filteredPrivate > 0) {
            host.appendChild(el('div', {class: 'audit-detail-row'},
                el('span', {class: 'audit-detail-label', text: 'Geblockt (Layer 2)'}),
                el('span', {class: 'audit-detail-value', text: `${e.filteredPrivate} private Note${e.filteredPrivate === 1 ? '' : 's'}`})
            ));
        }

        if (e.tokens !== undefined) {
            const parts: string[] = [];
            if (e.tokens.input !== undefined) parts.push(`Input ${e.tokens.input}`);
            if (e.tokens.output !== undefined) parts.push(`Output ${e.tokens.output}`);
            if (e.tokens.total !== undefined) parts.push(`Total ${e.tokens.total}`);
            if (parts.length > 0) {
                host.appendChild(el('div', {class: 'audit-detail-row'},
                    el('span', {class: 'audit-detail-label', text: 'Tokens'}),
                    el('span', {class: 'audit-detail-value', text: parts.join(' · ')})
                ));
            }
        }
    }
}