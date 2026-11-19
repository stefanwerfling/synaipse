import type {BenchmarkEntry, BenchmarkSet, BenchmarkSummary} from '@synaipse/core';
import {
    computeWinners,
    dimensionKeys,
    findEntry,
    generateEntryId,
    setEntryDeleted,
    summarizeBenchmarks,
    upsertEntry,
    withoutDeletedEntries
} from '@synaipse/core';
import {api} from './Api.js';
import {clear, el} from './Dom.js';
import {confirmDialog, promptDialog, validProjectName} from './Dialogs.js';
import {toast} from './Toast.js';

export interface BenchmarksPanelOptions {
    /** Open a linked note in the Notes tab. */
    onOpenNote?: (noteId: string) => void;
}

interface EntryFormFields {
    dimensions: Record<string, string>;
    metric: string;
    value: number;
    unit: string;
    higherIsBetter: boolean;
    context: string;
    noteLinks: string[];
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export class BenchmarksPanel {
    public readonly element: HTMLElement;

    private readonly opts: BenchmarksPanelOptions;
    private readonly picker: HTMLSelectElement;
    private readonly kpis: HTMLElement;
    private readonly filtersHost: HTMLElement;
    private readonly contentHost: HTMLElement;
    private readonly emptyHint: HTMLElement;

    private projects: string[] = [];
    private project: string | null = null;
    private set: BenchmarkSet | null = null;
    /** '' = no filter on that axis. */
    private metricFilter = '';
    private dimFilters: Record<string, string> = {};
    /** When false (default), soft-deleted entries are hidden from the table. */
    private showDeleted = false;
    /** Which "Vergleich" chart tab is active. */
    private chartView: 'bar' | 'bar-h' | 'trend' = 'bar';
    private addFormOpen = false;
    private editingId: string | null = null;
    private readonly expandedGroups = new Set<string>();
    private sort: {key: string; dir: 'asc' | 'desc'} = {key: 'value', dir: 'desc'};
    /**
     * Table grouping: ordered dimension keys that become nested, indented
     * parent rows — e.g. ['machine', 'backend'] groups by machine, then by
     * backend within each machine. Empty = flat table. Order always follows
     * dimensionKeys()' natural (first-seen) order, not selection order.
     */
    private groupByKeys: string[] = [];
    /** Keyed by a composite path (e.g. "machine=GB10|backend=vLLM|") so collapse state can't collide across sibling branches. */
    private readonly collapsedGroups = new Set<string>();
    private saving = false;

    public constructor(opts: BenchmarksPanelOptions = {}) {
        this.opts = opts;

        this.picker = el('select', {class: 'rm-picker-select', on: {change: () => void this.onPickProject()}}) as HTMLSelectElement;

        const newBtn = el('button', {
            class: 'rm-btn ghost',
            attrs: {type: 'button', title: 'Benchmark-Set für ein neues Projekt anlegen'},
            text: '＋ Projekt',
            on: {click: () => void this.createProject()}
        });

        this.kpis = el('div', {class: 'rm-kpis bm-kpis'});
        this.filtersHost = el('div', {class: 'bm-filters'});
        this.contentHost = el('div', {class: 'bm-content'});
        this.emptyHint = el('div', {class: 'rm-empty', style: {display: 'none'}});

        const header = el('div', {class: 'rm-head'},
            el('div', {class: 'rm-head-left'},
                el('h1', {class: 'rm-title', text: 'Benchmarks'}),
                el('p', {class: 'rm-sub', text: 'Speed-/Qualitäts-Vergleiche pro Projekt — Maschine, Backend, Technik: frei definierbare Dimensionen, kein festes Schema.'}),
                el('div', {class: 'rm-picker'},
                    el('span', {class: 'rm-picker-label', text: 'Projekt'}),
                    this.picker,
                    newBtn
                )
            )
        );

        this.element = el('div', {class: 'rm-panel bm-panel'}, header, this.kpis, this.filtersHost, this.emptyHint, this.contentHost);
    }

    public async onShow(): Promise<void> {
        await this.loadProjects();
    }

    /**
     * React to a vault-change event (from the MCP event stream). When Claude
     * mutates the current project's benchmarks via MCP, refetch so the table
     * updates without a manual reload.
     */
    public onVaultEvent(touched: readonly string[]): void {
        if (this.project === null || this.saving) return;
        if (!this.element.isConnected) return;
        if (touched.includes(`Memory/${this.project}/_benchmarks.md`)) {
            void this.loadSet();
        }
    }

    private async loadProjects(): Promise<void> {
        let summaries: BenchmarkSummary[] = [];
        try {
            summaries = await api.listBenchmarks();
        } catch (e) {
            console.error('failed to list benchmarks', e);
        }
        this.projects = summaries.map((s) => s.project);

        clear(this.picker);
        if (this.projects.length === 0) {
            this.picker.appendChild(el('option', {text: '— keine Benchmarks —', attrs: {value: ''}}));
        }
        for (const p of this.projects) {
            this.picker.appendChild(el('option', {text: p, attrs: {value: p}}));
        }

        if (this.project !== null && this.projects.includes(this.project)) {
            this.picker.value = this.project;
        } else {
            this.project = this.projects[0] ?? null;
            if (this.project !== null) this.picker.value = this.project;
        }

        if (this.project === null) {
            this.set = null;
            this.renderEmpty('Noch keine Benchmarks. Lege ein Set für ein Projekt an — oder lass Claude per MCP (synaipse_benchmark_add) loggen.');
            this.renderKpis(null);
            clear(this.filtersHost);
            return;
        }
        await this.loadSet();
    }

    private async onPickProject(): Promise<void> {
        this.project = this.picker.value || null;
        if (this.project === null) return;
        this.metricFilter = '';
        this.dimFilters = {};
        this.addFormOpen = false;
        this.editingId = null;
        await this.loadSet();
    }

    private async createProject(): Promise<void> {
        const name = await promptDialog({
            title: 'Neues Projekt',
            label: 'Projektname (a-z, 0-9, . _ -)',
            confirmLabel: 'Anlegen',
            cancelLabel: 'Abbrechen',
            validate: validProjectName
        });
        if (!name) return;
        this.project = name;
        this.set = {project: name, updatedAt: '', entries: []};
        try {
            await api.putBenchmark(name, this.set);
        } catch (e) {
            console.error('create benchmark set failed', e);
        }
        await this.loadProjects();
    }

    private async loadSet(): Promise<void> {
        if (this.project === null) return;
        try {
            this.set = await api.getBenchmark(this.project);
        } catch (e) {
            console.error('failed to load benchmarks', e);
            this.set = {project: this.project, updatedAt: '', entries: []};
        }
        // Default to grouping by every dimension key this project uses (e.g.
        // Machine → Backend) — otherwise every entry lands flat with all
        // dimensions as columns. Metric stays a plain, always-visible table
        // column — it's usually one entry per (dims, metric) combo, so
        // giving it its own collapsible group row is more chrome than
        // signal. Only set on a fresh load; re-renders after a mutation
        // leave the user's own level choices alone (unchecking boxes).
        this.groupByKeys = dimensionKeys(withoutDeletedEntries(this.set.entries));
        this.collapsedGroups.clear();
        this.render();
    }

    /** Clone → mutate → persist → adopt the server's result. */
    private async mutate(fn: (set: BenchmarkSet) => void): Promise<void> {
        if (this.set === null || this.project === null || this.saving) return;
        const draft: BenchmarkSet = structuredClone(this.set);
        fn(draft);
        this.set = draft;
        this.render();
        this.saving = true;
        try {
            this.set = await api.putBenchmark(this.project, draft);
        } catch (e) {
            console.error('save benchmarks failed', e);
        } finally {
            this.saving = false;
            this.render();
        }
    }

    // --- rendering ------------------------------------------------------------

    private renderEmpty(message: string): void {
        clear(this.contentHost);
        this.emptyHint.textContent = message;
        this.emptyHint.style.display = '';
    }

    private renderKpis(set: BenchmarkSet | null): void {
        clear(this.kpis);
        if (set === null) return;
        const visible = withoutDeletedEntries(set.entries);
        const summary = summarizeBenchmarks({...set, entries: visible});
        const deletedCount = set.entries.length - visible.length;

        const kpi = (label: string, value: string, warn = false): HTMLElement =>
            el('div', {class: warn ? 'rm-kpi warn' : 'rm-kpi'},
                el('div', {class: 'rm-kpi-k', text: label}),
                el('div', {class: 'rm-kpi-v', text: value})
            );

        this.kpis.appendChild(kpi('Einträge', String(summary.totalEntries)));
        this.kpis.appendChild(kpi('Dimensionen', String(summary.dimensionKeys.length)));
        this.kpis.appendChild(kpi('Metriken', String(summary.metrics.length)));
        this.kpis.appendChild(kpi('Gelöscht', String(deletedCount), deletedCount > 0));
    }

    /** Filter dropdowns are built dynamically from whatever dimension keys this project actually uses. */
    private renderFilters(set: BenchmarkSet): void {
        clear(this.filtersHost);
        const base = this.showDeleted ? set.entries : withoutDeletedEntries(set.entries);
        const keys = dimensionKeys(base);

        // Drop filter/grouping selections for keys that no longer exist (e.g. after a project switch).
        for (const key of Object.keys(this.dimFilters)) {
            if (!keys.includes(key)) delete this.dimFilters[key];
        }
        this.groupByKeys = this.groupByKeys.filter((k) => keys.includes(k));

        const metrics = [...new Set(base.map((e) => e.metric))].sort();
        const metricSel = el('select', {
            class: 'rm-picker-select',
            on: {change: (e) => { this.metricFilter = (e.target as HTMLSelectElement).value; this.render(); }}
        }) as HTMLSelectElement;
        metricSel.appendChild(el('option', {text: '— alle Metriken —', attrs: {value: ''}}));
        for (const m of metrics) {
            const opt = el('option', {text: m, attrs: {value: m}}) as HTMLOptionElement;
            if (m === this.metricFilter) opt.selected = true;
            metricSel.appendChild(opt);
        }
        this.filtersHost.appendChild(el('label', {class: 'bm-filter'}, el('span', {class: 'rm-picker-label', text: 'Metrik'}), metricSel));

        if (keys.length > 0) {
            // One checkbox per dimension key — check several to nest
            // sub-groups (e.g. machine, then backend within each machine).
            // Order always follows dimensionKeys()' natural order, not click
            // order, so the hierarchy stays predictable regardless of which
            // box you toggle. Metric is deliberately not offered here — it's
            // always a plain table column (see renderRow/renderTable).
            const groupHost = el('div', {class: 'bm-group-toggles'});
            for (const key of keys) {
                const checkbox = el('input', {attrs: {type: 'checkbox'}}) as HTMLInputElement;
                checkbox.checked = this.groupByKeys.includes(key);
                checkbox.addEventListener('change', () => {
                    this.groupByKeys = checkbox.checked
                        ? keys.filter((k) => this.groupByKeys.includes(k) || k === key)
                        : this.groupByKeys.filter((k) => k !== key);
                    this.collapsedGroups.clear();
                    this.render();
                });
                groupHost.appendChild(el('label', {class: 'bm-group-toggle'}, checkbox, el('span', {text: key})));
            }
            this.filtersHost.appendChild(el('label', {class: 'bm-filter'}, el('span', {class: 'rm-picker-label', text: 'Gruppieren nach'}), groupHost));
        }

        for (const key of keys) {
            const values = [...new Set(base.map((e) => e.dimensions[key]).filter((v): v is string => v !== undefined))].sort();
            const sel = el('select', {
                class: 'rm-picker-select',
                on: {change: (e) => { this.dimFilters[key] = (e.target as HTMLSelectElement).value; this.render(); }}
            }) as HTMLSelectElement;
            sel.appendChild(el('option', {text: '— alle —', attrs: {value: ''}}));
            for (const v of values) {
                const opt = el('option', {text: v, attrs: {value: v}}) as HTMLOptionElement;
                if (v === this.dimFilters[key]) opt.selected = true;
                sel.appendChild(opt);
            }
            this.filtersHost.appendChild(el('label', {class: 'bm-filter'}, el('span', {class: 'rm-picker-label', text: key}), sel));
        }

        const deletedCount = set.entries.length - withoutDeletedEntries(set.entries).length;
        if (deletedCount > 0) {
            const toggle = el('input', {attrs: {type: 'checkbox'}}) as HTMLInputElement;
            toggle.checked = this.showDeleted;
            toggle.addEventListener('change', () => {
                this.showDeleted = toggle.checked;
                this.render();
            });
            this.filtersHost.appendChild(el('label', {class: 'rm-deleted-toggle'},
                toggle,
                el('span', {text: `🗑 Gelöschte anzeigen (${deletedCount})`})
            ));
        }
    }

    private applyFilters(entries: readonly BenchmarkEntry[]): BenchmarkEntry[] {
        let out = [...entries];
        if (this.metricFilter !== '') {
            out = out.filter((e) => e.metric === this.metricFilter);
        }
        for (const [key, value] of Object.entries(this.dimFilters)) {
            if (value === '') continue;
            out = out.filter((e) => e.dimensions[key] === value);
        }
        return out;
    }

    private render(): void {
        if (this.set === null) {
            this.renderEmpty('Kein Benchmark-Set geladen.');
            this.renderKpis(null);
            clear(this.filtersHost);
            return;
        }
        const set = this.set;
        this.emptyHint.style.display = 'none';
        this.renderKpis(set);
        this.renderFilters(set);
        clear(this.contentHost);

        const base = this.showDeleted ? set.entries : withoutDeletedEntries(set.entries);
        const visible = this.applyFilters(base);

        const addBtn = el('button', {
            class: 'rm-btn',
            attrs: {type: 'button'},
            text: this.addFormOpen ? '－ Schließen' : '＋ Eintrag',
            on: {click: () => {
                this.addFormOpen = !this.addFormOpen;
                this.editingId = null;
                this.render();
            }}
        });
        this.contentHost.appendChild(el('div', {class: 'bm-add-row'}, addBtn));

        if (this.addFormOpen) {
            this.contentHost.appendChild(this.renderEntryForm(null, set, () => {
                this.addFormOpen = false;
                this.render();
            }));
        }

        if (visible.length === 0) {
            const msg = set.entries.length === 0
                ? 'Noch keine Benchmark-Einträge. „＋ Eintrag" oben — oder Claude trägt sie per MCP (synaipse_benchmark_add) ein.'
                : 'Keine Einträge für die aktuelle Filterauswahl.';
            this.contentHost.appendChild(el('p', {class: 'rm-empty-inline', text: msg}));
            return;
        }

        this.contentHost.appendChild(this.renderLeaderboard(visible));
        this.contentHost.appendChild(this.renderChart(visible));
        this.contentHost.appendChild(this.renderTable(visible, set));
    }

    // --- leaderboard ------------------------------------------------------------

    private renderLeaderboard(visible: BenchmarkEntry[]): HTMLElement {
        const section = el('section', {class: 'activity-section'});
        section.appendChild(el('h3', {class: 'activity-section-title', text: 'Leaderboard'}));

        // Ranking is scoped by metric plus whichever dimension filters are
        // currently pinned — pin "machine" to rank within that machine, leave
        // everything unpinned for a pure per-metric leaderboard across the project.
        const activeDimKeys = Object.keys(this.dimFilters).filter((k) => this.dimFilters[k] !== '');
        const groups = computeWinners(visible, ['metric', ...activeDimKeys]);

        if (groups.length === 0) {
            section.appendChild(el('div', {class: 'activity-empty', text: 'keine Daten'}));
            return section;
        }

        const list = el('ul', {class: 'activity-list'});
        for (const group of groups) {
            const winner = group.entries[0];
            if (winner === undefined) continue;

            const max = Math.max(...group.entries.map((e) => Math.abs(e.value)), 1);
            const extra = Object.entries(group.groupBy).filter(([k]) => k !== 'metric').map(([k, v]) => `${k}=${v}`).join(', ');
            const label = extra.length > 0 ? `${group.groupBy.metric ?? ''} — ${extra}` : (group.groupBy.metric ?? '');
            const expanded = this.expandedGroups.has(group.key);

            const row = el('li', {class: 'activity-bar-row', attrs: {role: 'button', tabindex: '0'}},
                el('div', {class: 'activity-bar-bg'},
                    el('div', {class: 'activity-bar-fill', style: {width: `${(Math.abs(winner.value) / max) * 100}%`}})
                ),
                el('div', {class: 'activity-bar-content'},
                    el('span', {class: 'activity-bar-label', text: `🏆 ${label}`}),
                    el('span', {class: 'activity-bar-value', text: `${winner.value.toLocaleString('de-DE')} ${winner.unit}`})
                )
            );
            row.addEventListener('click', () => {
                if (this.expandedGroups.has(group.key)) this.expandedGroups.delete(group.key);
                else this.expandedGroups.add(group.key);
                this.render();
            });
            list.appendChild(row);

            if (expanded && group.entries.length > 1) {
                const rankList = el('ol', {class: 'bm-rank-list'});
                group.entries.forEach((e, i) => {
                    const dims = Object.entries(e.dimensions).map(([k, v]) => `${k}=${v}`).join(', ');
                    rankList.appendChild(el('li', {}, `${dims || e.metric} — ${e.value.toLocaleString('de-DE')} ${e.unit}`, i === 0 ? ' 🏆' : ''));
                });
                list.appendChild(el('li', {class: 'bm-group-detail'}, rankList));
            }
        }
        section.appendChild(list);
        return section;
    }

    // --- chart ------------------------------------------------------------

    private renderChart(visible: BenchmarkEntry[]): HTMLElement {
        const section = el('section', {class: 'activity-section'});
        section.appendChild(el('h3', {class: 'activity-section-title', text: 'Vergleich'}));

        // No metric picked: show every metric's comparison at once (small
        // multiples) instead of forcing a pick-one-metric-first empty state
        // — that's the overview a user actually wants before drilling in.
        if (this.metricFilter === '') {
            section.appendChild(this.renderAllMetricsOverview(visible));
            return section;
        }

        const items = visible.filter((e) => e.metric === this.metricFilter);
        if (items.length === 0) {
            section.appendChild(el('div', {class: 'activity-empty', text: 'keine Daten für diese Metrik'}));
            return section;
        }

        const views: ReadonlyArray<{id: 'bar' | 'bar-h' | 'trend'; label: string}> = [
            {id: 'bar', label: 'Balken'},
            {id: 'bar-h', label: 'Balken (horizontal)'},
            {id: 'trend', label: 'Verlauf'}
        ];
        const tabs = el('div', {class: 'bm-chart-tabs'});
        for (const v of views) {
            tabs.appendChild(el('button', {
                class: `bm-chart-tab${this.chartView === v.id ? ' active' : ''}`,
                attrs: {type: 'button'},
                text: v.label,
                on: {click: () => { this.chartView = v.id; this.render(); }}
            }));
        }
        section.appendChild(tabs);

        // Label bars/points by whichever dimensions AREN'T already pinned by
        // a filter — that's the axis actually being compared (e.g. backend,
        // once machine is pinned).
        const activeDimKeys = new Set(Object.keys(this.dimFilters).filter((k) => this.dimFilters[k] !== ''));
        const labelKeys = dimensionKeys(items).filter((k) => !activeDimKeys.has(k));
        const labelFor = (e: BenchmarkEntry): string =>
            labelKeys.map((k) => e.dimensions[k]).filter((v): v is string => v !== undefined).join(' / ') || e.metric;

        if (this.chartView === 'trend') {
            section.appendChild(this.renderTrendChart(items, labelFor));
            return section;
        }

        const higherIsBetter = items[0]?.higherIsBetter ?? true;
        const sorted = [...items].sort((a, b) => higherIsBetter ? b.value - a.value : a.value - b.value);
        section.appendChild(
            this.chartView === 'bar-h'
                ? this.renderHorizontalBarChart(sorted, labelFor)
                : this.renderBarChart(sorted, labelFor)
        );
        return section;
    }

    /**
     * Default "Vergleich" view when no metric is picked: one compact
     * horizontal-bar comparison per metric, side by side, so you can scan
     * every comparison at a glance instead of picking metrics one at a time.
     * Each card has its own scale (values across metrics aren't comparable —
     * tok/s and ms/tok can't share an axis), same rule as the single view.
     */
    private renderAllMetricsOverview(visible: BenchmarkEntry[]): HTMLElement {
        const activeDimKeys = new Set(Object.keys(this.dimFilters).filter((k) => this.dimFilters[k] !== ''));
        const metrics = [...new Set(visible.map((e) => e.metric))].sort();

        if (metrics.length === 0) {
            return el('div', {class: 'activity-empty', text: 'keine Daten'});
        }

        const grid = el('div', {class: 'bm-overview-grid'});
        for (const metric of metrics) {
            const items = visible.filter((e) => e.metric === metric);
            const higherIsBetter = items[0]?.higherIsBetter ?? true;
            const sorted = [...items].sort((a, b) => higherIsBetter ? b.value - a.value : a.value - b.value);
            const labelKeys = dimensionKeys(sorted).filter((k) => !activeDimKeys.has(k));
            const labelFor = (e: BenchmarkEntry): string =>
                labelKeys.map((k) => e.dimensions[k]).filter((v): v is string => v !== undefined).join(' / ') || e.metric;

            const card = el('div', {
                class: 'bm-overview-card',
                attrs: {role: 'button', title: 'Klicken, um diese Metrik einzeln zu betrachten'},
                on: {click: () => { this.metricFilter = metric; this.render(); }}
            },
                el('div', {class: 'bm-overview-title', text: metric}),
                this.renderHorizontalBarChart(sorted, labelFor)
            );
            grid.appendChild(card);
        }
        return grid;
    }

    private renderBarChart(sorted: BenchmarkEntry[], labelFor: (e: BenchmarkEntry) => string): HTMLElement {
        const wrap = el('div', {});
        const chartHost = el('div', {class: 'activity-chart'});
        const max = Math.max(...sorted.map((e) => Math.abs(e.value)), 1);
        const width = Math.max(sorted.length * 60, 320);
        const height = 180;
        const padding = 24;

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('class', 'activity-svg');

        const barWidth = Math.max(16, (width - padding * 2) / sorted.length - 8);

        sorted.forEach((entry, i) => {
            const h = ((height - padding * 2) * Math.abs(entry.value)) / max;
            const x = padding + i * ((width - padding * 2) / sorted.length);
            const y = height - padding - h;

            const rect = document.createElementNS(SVG_NS, 'rect');
            rect.setAttribute('x', String(x));
            rect.setAttribute('y', String(y));
            rect.setAttribute('width', String(barWidth));
            rect.setAttribute('height', String(h));
            rect.setAttribute('fill', i === 0 ? 'var(--accent)' : 'var(--text-2)');
            rect.setAttribute('rx', '2');

            const title = document.createElementNS(SVG_NS, 'title');
            title.textContent = `${labelFor(entry)}: ${entry.value.toLocaleString('de-DE')} ${entry.unit}`;
            rect.appendChild(title);

            svg.appendChild(rect);
        });

        chartHost.appendChild(svg);
        wrap.appendChild(chartHost);

        const labels = el('div', {class: 'activity-chart-labels bm-chart-labels'});
        for (const entry of sorted) {
            labels.appendChild(el('span', {text: labelFor(entry)}));
        }
        wrap.appendChild(labels);

        return wrap;
    }

    /** Horizontal ranking view — reuses the leaderboard's bar-row pattern (label left, bar behind, value right). */
    private renderHorizontalBarChart(sorted: BenchmarkEntry[], labelFor: (e: BenchmarkEntry) => string): HTMLElement {
        const max = Math.max(...sorted.map((e) => Math.abs(e.value)), 1);
        const list = el('ul', {class: 'activity-list'});
        sorted.forEach((entry, i) => {
            const pct = (Math.abs(entry.value) / max) * 100;
            list.appendChild(el('li', {class: 'activity-bar-row'},
                el('div', {class: 'activity-bar-bg'},
                    el('div', {class: 'activity-bar-fill', style: {width: `${pct}%`, ...(i === 0 ? {background: 'var(--accent)'} : {})}})
                ),
                el('div', {class: 'activity-bar-content'},
                    el('span', {class: 'activity-bar-label', text: labelFor(entry)}),
                    el('span', {class: 'activity-bar-value', text: `${entry.value.toLocaleString('de-DE')} ${entry.unit}`})
                )
            ));
        });
        return list;
    }

    /** Multi-series line/scatter of value over recordedAt — one series per distinct label (e.g. per backend). */
    private renderTrendChart(items: BenchmarkEntry[], labelFor: (e: BenchmarkEntry) => string): HTMLElement {
        const wrap = el('div', {});
        const dated = items.filter((e) => e.recordedAt !== undefined);
        if (dated.length === 0) {
            wrap.appendChild(el('div', {class: 'activity-empty', text: 'Keine Einträge mit Zeitstempel für einen Verlauf.'}));
            return wrap;
        }

        const series = new Map<string, BenchmarkEntry[]>();
        for (const entry of dated) {
            const label = labelFor(entry);
            const list = series.get(label) ?? [];
            list.push(entry);
            series.set(label, list);
        }
        for (const list of series.values()) {
            list.sort((a, b) => (a.recordedAt ?? '').localeCompare(b.recordedAt ?? ''));
        }

        const timeOf = (e: BenchmarkEntry): number => new Date(e.recordedAt as string).getTime();
        const times = dated.map(timeOf);
        const minT = Math.min(...times);
        const maxT = Math.max(...times);
        const values = dated.map((e) => e.value);
        const minV = Math.min(0, ...values);
        const maxV = Math.max(...values, 1);

        const width = 560;
        const height = 200;
        const padding = 28;
        const xFor = (t: number): number =>
            maxT === minT ? width / 2 : padding + ((t - minT) / (maxT - minT)) * (width - padding * 2);
        const yFor = (v: number): number =>
            maxV === minV ? height / 2 : height - padding - ((v - minV) / (maxV - minV)) * (height - padding * 2);

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('class', 'activity-svg');

        const colors = ['var(--accent)', '#0DCE74', '#EF2CC1', '#3D99F5', '#FEA595', '#A373ED'];
        const legend = el('div', {class: 'bm-trend-legend'});
        let colorIdx = 0;
        for (const [label, list] of series) {
            const color = colors[colorIdx % colors.length] as string;
            colorIdx += 1;

            if (list.length > 1) {
                const points = list.map((e) => `${xFor(timeOf(e))},${yFor(e.value)}`).join(' ');
                const polyline = document.createElementNS(SVG_NS, 'polyline');
                polyline.setAttribute('points', points);
                polyline.setAttribute('fill', 'none');
                polyline.setAttribute('stroke', color);
                polyline.setAttribute('stroke-width', '2');
                svg.appendChild(polyline);
            }

            for (const entry of list) {
                const circle = document.createElementNS(SVG_NS, 'circle');
                circle.setAttribute('cx', String(xFor(timeOf(entry))));
                circle.setAttribute('cy', String(yFor(entry.value)));
                circle.setAttribute('r', '4');
                circle.setAttribute('fill', color);
                const title = document.createElementNS(SVG_NS, 'title');
                title.textContent =
                    `${label}: ${entry.value.toLocaleString('de-DE')} ${entry.unit} — ${new Date(entry.recordedAt as string).toLocaleString('de-DE')}`;
                circle.appendChild(title);
                svg.appendChild(circle);
            }

            legend.appendChild(el('span', {class: 'bm-trend-legend-item'},
                el('span', {class: 'bm-trend-swatch', style: {background: color}}),
                label
            ));
        }

        wrap.appendChild(el('div', {class: 'activity-chart'}, svg));
        wrap.appendChild(legend);
        return wrap;
    }

    // --- table ------------------------------------------------------------

    private sortEntries(entries: readonly BenchmarkEntry[]): BenchmarkEntry[] {
        const {key, dir} = this.sort;
        const mul = dir === 'asc' ? 1 : -1;
        const valueOf = (e: BenchmarkEntry): string | number => {
            if (key === 'metric') return e.metric;
            if (key === 'value') return e.value;
            if (key === 'unit') return e.unit;
            if (key === 'recordedAt') return e.recordedAt ?? '';
            return e.dimensions[key] ?? '';
        };
        return [...entries].sort((a, b) => {
            const av = valueOf(a);
            const bv = valueOf(b);
            if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
            return String(av).localeCompare(String(bv)) * mul;
        });
    }

    private sortableHeader(label: string, key: string, extraCls = ''): HTMLElement {
        const active = this.sort.key === key;
        const arrow = active ? (this.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
        return el('th', {
            class: extraCls,
            attrs: {title: 'Sortieren'},
            on: {click: () => this.toggleSort(key)}
        }, `${label}${arrow}`);
    }

    private toggleSort(key: string): void {
        this.sort = this.sort.key === key
            ? {key, dir: this.sort.dir === 'asc' ? 'desc' : 'asc'}
            : {key, dir: 'asc'};
        this.render();
    }

    private renderTable(visible: BenchmarkEntry[], set: BenchmarkSet): HTMLElement {
        const keys = dimensionKeys(visible);
        const winnerIds = new Set(
            computeWinners(visible, ['metric']).map((g) => g.entries[0]?.id).filter((id): id is string => id !== undefined)
        );

        // Active group keys' values become their own indented parent rows, in
        // order, so they're dropped from the per-entry dimension columns —
        // showing "GB10/Spark" in both a group header AND every row nested
        // under it is redundant once the row already sits under that header.
        // Metric is deliberately never a group key here — usually one entry
        // per (dims, metric) combo, so it stays a plain, always-visible,
        // sortable column instead of its own collapsible group row.
        const groupKeys = this.groupByKeys.filter((k) => keys.includes(k));
        const rowKeys = keys.filter((k) => !groupKeys.includes(k));
        const totalCols = rowKeys.length + 6; // metric, value, unit, recorded, notes, actions

        const table = el('table', {class: 'rm-table bm-table'});
        table.appendChild(el('thead', {}, el('tr', {},
            ...rowKeys.map((k) => this.sortableHeader(k, k)),
            this.sortableHeader('Metrik', 'metric'),
            this.sortableHeader('Wert', 'value', 'r'),
            this.sortableHeader('Einheit', 'unit'),
            this.sortableHeader('Erfasst', 'recordedAt'),
            el('th', {text: 'Notizen'}),
            el('th', {text: ''})
        )));

        const tbody = el('tbody');
        this.renderGroupedRows(tbody, this.sortEntries(visible), groupKeys, rowKeys, winnerIds, totalCols, set, 0, '');
        table.appendChild(tbody);
        return el('div', {class: 'rm-scroll'}, table);
    }

    /**
     * Recursively nests rows by `remainingGroupKeys`, one level of indented
     * parent rows per key, then renders leaf entry rows at the bottom of the
     * recursion. `path` is a composite id (e.g. "machine=GB10|backend=vLLM|")
     * so collapse state can't collide between sibling branches that happen to
     * share a value (two machines both having a "vLLM" backend, say).
     */
    private renderGroupedRows(
        tbody: HTMLElement,
        entries: readonly BenchmarkEntry[],
        remainingGroupKeys: readonly string[],
        rowKeys: readonly string[],
        winnerIds: ReadonlySet<string>,
        totalCols: number,
        set: BenchmarkSet,
        depth: number,
        path: string
    ): void {
        const [key, ...restKeys] = remainingGroupKeys;
        if (key === undefined) {
            for (const entry of entries) {
                tbody.appendChild(this.renderRow(entry, rowKeys, winnerIds.has(entry.id), depth));
                if (this.editingId === entry.id) {
                    tbody.appendChild(el('tr', {},
                        el('td', {attrs: {colspan: String(totalCols)}},
                            this.renderEntryForm(entry, set, () => { this.editingId = null; this.render(); })
                        )
                    ));
                }
            }
            return;
        }

        const groups = new Map<string, BenchmarkEntry[]>();
        for (const entry of entries) {
            const groupValue = entry.dimensions[key] ?? '—';
            const list = groups.get(groupValue) ?? [];
            list.push(entry);
            groups.set(groupValue, list);
        }
        for (const [groupValue, groupEntries] of groups) {
            const groupPath = `${path}${key}=${groupValue}|`;
            const collapsed = this.collapsedGroups.has(groupPath);
            tbody.appendChild(this.renderGroupRow(key, groupValue, groupEntries.length, totalCols, collapsed, depth, groupPath));
            if (!collapsed) {
                this.renderGroupedRows(tbody, groupEntries, restKeys, rowKeys, winnerIds, totalCols, set, depth + 1, groupPath);
            }
        }
    }

    /** Parent row for a grouped-by dimension value at a given nesting depth — click/caret toggles its children. */
    private renderGroupRow(
        key: string,
        value: string,
        count: number,
        colSpan: number,
        collapsed: boolean,
        depth: number,
        path: string
    ): HTMLElement {
        const toggle = (): void => {
            if (this.collapsedGroups.has(path)) this.collapsedGroups.delete(path);
            else this.collapsedGroups.add(path);
            this.render();
        };
        return el('tr', {class: 'bm-group-row', on: {click: toggle}},
            el('td', {attrs: {colspan: String(colSpan)}},
                el('div', {class: 'bm-group-head'},
                    depth > 0 ? el('span', {class: 'bm-indent', style: {width: `${depth * 30}px`}}) : null,
                    el('span', {class: `rm-caret ${collapsed ? 'collapsed' : 'open'}`},
                        el('span', {class: 'rm-caret-tw', text: collapsed ? '▸' : '▾'})
                    ),
                    el('span', {class: 'bm-group-key', text: key}),
                    el('span', {class: 'bm-group-label', text: value}),
                    el('span', {class: 'bm-group-count', text: String(count)})
                )
            )
        );
    }

    private renderRow(
        entry: BenchmarkEntry,
        keys: readonly string[],
        isWinner: boolean,
        depth: number
    ): HTMLElement {
        // Explicit spacer span, prepended to whichever cell renders first — a
        // dimension column if any remain, otherwise the metric cell (always
        // shown — metric is never a group key, see renderTable). Own
        // class/width (not RoadmapPanel's .rm-indent) — measured live in the
        // browser: a bare 20px roadmap-style indent IS applied correctly (real
        // DOM offset, confirmed via getBoundingClientRect), but reads as
        // basically invisible in this table without a caret/connector next to
        // it the way roadmap rows have — paired with a visible border-left
        // guide on the row instead (see .bm-child-row in Styles.css). Width
        // scales with nesting depth so a leaf under two group levels sits
        // further right than one under a single level.
        const makeIndent = (): HTMLElement | null =>
            depth > 0 ? el('span', {class: 'bm-indent', style: {width: `${depth * 30}px`}}) : null;

        const dimCells = keys.map((k, i) => {
            const value = entry.dimensions[k] ?? '—';
            return i === 0
                ? el('td', {}, makeIndent(), el('span', {text: value}))
                : el('td', {text: value});
        });
        const metricCell = keys.length === 0
            ? el('td', {}, makeIndent(), el('span', {text: entry.metric}))
            : el('td', {text: entry.metric});
        const valueCell = el('td', {class: 'r num', text: entry.value.toLocaleString('de-DE')});

        const notes = el('div', {class: 'rm-notes'});
        for (const link of entry.noteLinks ?? []) {
            notes.appendChild(el('a', {
                class: 'rm-nchip',
                attrs: {href: '#', title: link},
                text: link,
                on: {click: (e) => {
                    e.preventDefault();
                    this.opts.onOpenNote?.(link);
                }}
            }));
        }

        const recorded = entry.recordedAt
            ? new Date(entry.recordedAt).toLocaleDateString('de-DE')
            : '—';

        const actions = entry.deleted
            ? el('div', {class: 'rm-row-actions'},
                el('button', {class: 'rm-icon', attrs: {type: 'button', title: 'Wiederherstellen', 'aria-label': 'Wiederherstellen'}, text: '♻', on: {click: () => void this.restoreEntry(entry.id)}})
            )
            : el('div', {class: 'rm-row-actions'},
                el('button', {
                    class: 'rm-icon',
                    attrs: {type: 'button', title: 'Bearbeiten', 'aria-label': 'Bearbeiten'},
                    text: '✎',
                    on: {click: () => {
                        this.editingId = this.editingId === entry.id ? null : entry.id;
                        this.addFormOpen = false;
                        this.render();
                    }}
                }),
                el('button', {class: 'rm-icon danger', attrs: {type: 'button', title: 'Als gelöscht markieren (ausblenden, wiederherstellbar)', 'aria-label': 'Als gelöscht markieren (ausblenden, wiederherstellbar)'}, text: '🗑', on: {click: () => void this.deleteEntry(entry.id)}})
            );

        const rowCls = ['rm-row', entry.deleted ? 'rm-deleted' : '', depth > 0 ? 'bm-child-row' : ''].filter(Boolean).join(' ');
        return el('tr', {class: rowCls},
            ...dimCells,
            metricCell,
            valueCell,
            el('td', {text: entry.unit}),
            el('td', {text: recorded}),
            el('td', {}, notes),
            el('td', {}, isWinner ? el('span', {class: 'bm-winner-badge', attrs: {title: 'Bestwert für diese Metrik'}, text: '🏆'}) : null, actions)
        );
    }

    // --- add/edit form ------------------------------------------------------------

    /** Builds the dynamic key/value dimension rows; returns a getter for the current values. */
    private buildDimensionRows(
        host: HTMLElement,
        initial: Record<string, string>
    ): {addRow: (key?: string, value?: string) => void; getValues: () => Record<string, string>} {
        const rows: Array<{keyInput: HTMLInputElement; valueInput: HTMLInputElement}> = [];

        const addRow = (key = '', value = ''): void => {
            const keyInput = el('input', {class: 'bm-dim-input', attrs: {type: 'text', placeholder: 'Key', list: 'bm-dim-keys', value: key}}) as HTMLInputElement;
            const valueInput = el('input', {class: 'bm-dim-input', attrs: {type: 'text', placeholder: 'Wert', value}}) as HTMLInputElement;
            const row = el('div', {class: 'bm-dim-row'}, keyInput, valueInput,
                el('button', {
                    class: 'rm-icon danger',
                    attrs: {type: 'button', title: 'Dimension entfernen', 'aria-label': 'Dimension entfernen'},
                    text: '✕',
                    on: {click: () => {
                        row.remove();
                        const idx = rows.findIndex((r) => r.keyInput === keyInput);
                        if (idx >= 0) rows.splice(idx, 1);
                    }}
                })
            );
            rows.push({keyInput, valueInput});
            host.appendChild(row);
        };

        const entries = Object.entries(initial);
        if (entries.length > 0) {
            for (const [k, v] of entries) addRow(k, v);
        } else {
            addRow();
        }

        return {
            addRow,
            getValues: (): Record<string, string> => {
                const out: Record<string, string> = {};
                for (const r of rows) {
                    const k = r.keyInput.value.trim();
                    const v = r.valueInput.value.trim();
                    if (k.length > 0 && v.length > 0) out[k] = v;
                }
                return out;
            }
        };
    }

    private renderEntryForm(existing: BenchmarkEntry | null, set: BenchmarkSet, onCancel: () => void): HTMLElement {
        const knownKeys = dimensionKeys(set.entries);
        const knownMetrics = [...new Set(set.entries.map((e) => e.metric))];

        const dimHost = el('div', {class: 'bm-dim-rows'});
        const dimCtl = this.buildDimensionRows(dimHost, existing?.dimensions ?? {});
        const dimKeyList = el('datalist', {attrs: {id: 'bm-dim-keys'}}, ...knownKeys.map((k) => el('option', {attrs: {value: k}})));
        const metricList = el('datalist', {attrs: {id: 'bm-metrics'}}, ...knownMetrics.map((m) => el('option', {attrs: {value: m}})));

        const addDimBtn = el('button', {
            class: 'rm-btn ghost sm',
            attrs: {type: 'button'},
            text: '＋ Dimension',
            on: {click: () => dimCtl.addRow()}
        });

        const metricInput = el('input', {class: 'rm-edit-input', attrs: {type: 'text', placeholder: 'z.B. decode_tok_s', value: existing?.metric ?? '', list: 'bm-metrics'}}) as HTMLInputElement;
        const valueInput = el('input', {class: 'rm-edit-input', attrs: {type: 'number', step: 'any', value: existing !== null ? String(existing.value) : ''}}) as HTMLInputElement;
        const unitInput = el('input', {class: 'rm-edit-input', attrs: {type: 'text', placeholder: 'z.B. tok/s', value: existing?.unit ?? ''}}) as HTMLInputElement;
        const higherCheckbox = el('input', {attrs: {type: 'checkbox'}}) as HTMLInputElement;
        higherCheckbox.checked = existing?.higherIsBetter ?? true;
        const contextArea = el('textarea', {class: 'rm-edit-area', attrs: {rows: '2', placeholder: 'z.B. single-user, 2316-tok prompt'}}) as HTMLTextAreaElement;
        contextArea.value = existing?.context ?? '';
        const noteLinksInput = el('input', {class: 'rm-edit-input', attrs: {type: 'text', placeholder: 'Notiz-Titel, kommagetrennt', value: (existing?.noteLinks ?? []).join(', ')}}) as HTMLInputElement;

        const field = (label: string, control: HTMLElement): HTMLElement =>
            el('label', {class: 'rm-edit-field'}, el('span', {class: 'rm-edit-lbl', text: label}), control);

        const save = (): void => {
            const dimensions = dimCtl.getValues();
            const metric = metricInput.value.trim();
            const value = Number.parseFloat(valueInput.value);
            const unit = unitInput.value.trim();

            if (Object.keys(dimensions).length === 0 || metric.length === 0 || !Number.isFinite(value) || unit.length === 0) {
                toast('Mindestens eine Dimension, Metrik, Wert und Einheit sind Pflichtfelder.', {kind: 'error'});
                return;
            }

            const noteLinks = noteLinksInput.value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
            void this.saveEntry(existing?.id ?? null, {
                dimensions,
                metric,
                value,
                unit,
                higherIsBetter: higherCheckbox.checked,
                context: contextArea.value.trim(),
                noteLinks
            });
        };

        return el('div', {class: 'bm-form'},
            dimKeyList,
            metricList,
            el('div', {class: 'bm-form-row'},
                el('span', {class: 'rm-edit-lbl', text: 'Dimensionen'}),
                dimHost,
                addDimBtn
            ),
            el('div', {class: 'bm-form-grid'},
                field('Metrik', metricInput),
                field('Wert', valueInput),
                field('Einheit', unitInput),
                el('label', {class: 'rm-edit-field'}, el('span', {class: 'rm-edit-lbl', text: 'Höher ist besser'}), higherCheckbox)
            ),
            field('Kontext', contextArea),
            field('Notiz-Links', noteLinksInput),
            el('div', {class: 'rm-edit-actions'},
                el('button', {class: 'rm-btn sm', attrs: {type: 'button'}, text: 'Speichern', on: {click: save}}),
                el('button', {class: 'rm-btn ghost sm', attrs: {type: 'button'}, text: 'Abbrechen', on: {click: onCancel}})
            )
        );
    }

    // --- mutations ------------------------------------------------------------

    private async saveEntry(id: string | null, fields: EntryFormFields): Promise<void> {
        this.addFormOpen = false;
        this.editingId = null;
        await this.mutate((set) => {
            const entry: BenchmarkEntry = {
                id: id ?? generateEntryId(),
                dimensions: fields.dimensions,
                metric: fields.metric,
                value: fields.value,
                unit: fields.unit,
                higherIsBetter: fields.higherIsBetter,
                recordedAt: (id !== null ? findEntry(set.entries, id)?.recordedAt : undefined) ?? new Date().toISOString()
            };
            if (fields.context.length > 0) entry.context = fields.context;
            if (fields.noteLinks.length > 0) entry.noteLinks = fields.noteLinks;
            set.entries = upsertEntry(set.entries, entry);
        });
    }

    /**
     * Soft-delete an entry: it is marked `deleted` and hidden, but kept in the
     * vault so it stays reversible. Entries are never hard-removed.
     */
    private async deleteEntry(id: string): Promise<void> {
        const ok = await confirmDialog({
            title: 'Eintrag löschen?',
            message: 'Der Eintrag wird als gelöscht markiert und ausgeblendet. Er bleibt im Vault erhalten und lässt sich wiederherstellen.',
            confirmLabel: 'Löschen',
            cancelLabel: 'Abbrechen',
            danger: true
        });
        if (!ok) return;
        await this.mutate((set) => {
            set.entries = setEntryDeleted(set.entries, id, true);
        });
    }

    /** Restore a soft-deleted entry. */
    private async restoreEntry(id: string): Promise<void> {
        await this.mutate((set) => {
            set.entries = setEntryDeleted(set.entries, id, false);
        });
    }
}
