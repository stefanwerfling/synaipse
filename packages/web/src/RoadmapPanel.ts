import type {Roadmap, RoadmapStatus, RoadmapStep, RoadmapSummary} from '@synaipse/core';
import {setStepDeleted, withoutDeleted} from '@synaipse/core';
import {api} from './Api.js';
import {clear, el} from './Dom.js';

export interface RoadmapPanelOptions {
    /** Open a linked note in the Notes tab. */
    onOpenNote?: (noteId: string) => void;
}

const STATUS_ORDER: RoadmapStatus[] = [
    'backlog',
    'planned',
    'in_progress',
    'ai_active',
    'review',
    'blocked',
    'done',
    'cancelled'
];

const STATUS_LABEL: Record<RoadmapStatus, string> = {
    backlog: 'Backlog',
    planned: 'Geplant',
    in_progress: 'In Arbeit',
    ai_active: 'KI aktiv',
    review: 'Review',
    blocked: 'Blockiert',
    done: 'Fertig',
    cancelled: 'Abgebrochen'
};

const STATUS_CLASS: Record<RoadmapStatus, string> = {
    backlog: 'rm-backlog',
    planned: 'rm-backlog',
    in_progress: 'rm-prog',
    ai_active: 'rm-ai',
    review: 'rm-review',
    blocked: 'rm-blocked',
    done: 'rm-done',
    cancelled: 'rm-backlog'
};

const fmtHours = (n: number | undefined): string =>
    n === undefined ? '—' : `${n.toLocaleString('de-DE')} h`;

/** Delta between planned and actual, as a signed string plus a CSS class. */
const variance = (step: RoadmapStep): {text: string; cls: string} => {
    if (step.plannedHours === undefined || step.actualHours === undefined) {
        return {text: '—', cls: 'rm-var-none'};
    }
    const d = Math.round((step.actualHours - step.plannedHours) * 10) / 10;
    if (d === 0) return {text: '0', cls: 'rm-var-none'};
    return d > 0
        ? {text: `+${d.toLocaleString('de-DE')}`, cls: 'rm-var-over'}
        : {text: d.toLocaleString('de-DE'), cls: 'rm-var-under'};
};

const flatten = (steps: RoadmapStep[], depth = 0, out: Array<{step: RoadmapStep; depth: number}> = []): Array<{step: RoadmapStep; depth: number}> => {
    for (const step of steps) {
        out.push({step, depth});
        if (step.children && step.children.length > 0) {
            flatten(step.children, depth + 1, out);
        }
    }
    return out;
};

/**
 * Like {@link flatten}, but children of a collapsed step are skipped — this is
 * what the table renders, so a huge roadmap can be folded down to its phases.
 * `hidden` is filled with the count of rows a collapsed step is hiding, for the
 * "▸ (12)" badge.
 */
const flattenCollapsed = (
    steps: RoadmapStep[],
    collapsed: ReadonlySet<string>,
    depth = 0,
    out: Array<{step: RoadmapStep; depth: number; hiddenCount: number}> = []
): Array<{step: RoadmapStep; depth: number; hiddenCount: number}> => {
    for (const step of steps) {
        const kids = step.children ?? [];
        const isCollapsed = kids.length > 0 && collapsed.has(step.id);
        out.push({step, depth, hiddenCount: isCollapsed ? flatten(kids).length : 0});
        if (kids.length > 0 && !isCollapsed) {
            flattenCollapsed(kids, collapsed, depth + 1, out);
        }
    }
    return out;
};

/** Ids of every step that has children (candidates for collapse). */
const parentIds = (steps: RoadmapStep[]): string[] => {
    const out: string[] = [];
    for (const {step} of flatten(steps)) {
        if (step.children && step.children.length > 0) out.push(step.id);
    }
    return out;
};

/** Ancestor ids of `id` (root → parent), empty when not found or top-level. */
const ancestorsOf = (steps: RoadmapStep[], id: string, trail: string[] = []): string[] | null => {
    for (const step of steps) {
        if (step.id === id) return trail;
        if (step.children) {
            const hit = ancestorsOf(step.children, id, [...trail, step.id]);
            if (hit) return hit;
        }
    }
    return null;
};

/** Next free hierarchical id under a parent (or at root when parent is null). */
const nextId = (steps: RoadmapStep[], parentId: string | null): string => {
    if (parentId === null) {
        const tops = steps
            .map((s) => Number.parseInt(s.id.split('.')[0] ?? '', 10))
            .filter((n) => Number.isFinite(n));
        const max = tops.length > 0 ? Math.max(...tops) : 0;
        return String(max + 1);
    }
    const parent = findStepLocal(steps, parentId);
    const n = (parent?.children?.length ?? 0) + 1;
    return `${parentId}.${n}`;
};

const findStepLocal = (steps: RoadmapStep[], id: string): RoadmapStep | null => {
    for (const s of steps) {
        if (s.id === id) return s;
        if (s.children) {
            const hit = findStepLocal(s.children, id);
            if (hit) return hit;
        }
    }
    return null;
};

export class RoadmapPanel {
    public readonly element: HTMLElement;

    private readonly opts: RoadmapPanelOptions;
    private readonly picker: HTMLSelectElement;
    private readonly banner: HTMLElement;
    private readonly kpis: HTMLElement;
    private readonly tableWrap: HTMLElement;
    private readonly emptyHint: HTMLElement;

    private projects: string[] = [];
    private project: string | null = null;
    private roadmap: Roadmap | null = null;
    /** Steps whose detail row (evaluation/activity) is open. */
    private readonly expanded = new Set<string>();
    /** Steps whose detail row is currently in edit mode. */
    private readonly editing = new Set<string>();
    /** Parent steps whose sub-steps are folded away in the table. */
    private collapsed = new Set<string>();
    private saving = false;
    /** When false (default), soft-deleted steps are hidden from the table. */
    private showDeleted = false;

    public constructor(opts: RoadmapPanelOptions = {}) {
        this.opts = opts;

        this.picker = el('select', {class: 'rm-picker-select', on: {change: () => void this.onPickProject()}}) as HTMLSelectElement;

        const newBtn = el('button', {
            class: 'rm-btn ghost',
            attrs: {type: 'button', title: 'Roadmap für ein neues Projekt anlegen'},
            text: '＋ Projekt',
            on: {click: () => void this.createProject()}
        });

        this.banner = el('div', {class: 'rm-banner', style: {display: 'none'}});
        this.kpis = el('div', {class: 'rm-kpis'});
        this.tableWrap = el('div', {class: 'rm-table-wrap'});
        this.emptyHint = el('div', {class: 'rm-empty', style: {display: 'none'}});

        const header = el('div', {class: 'rm-head'},
            el('div', {class: 'rm-head-left'},
                el('h1', {class: 'rm-title', text: 'Roadmap'}),
                el('p', {class: 'rm-sub', text: 'KI-geplante Umsetzungsschritte pro Projekt — Status, Zeit geplant/umgesetzt, verlinkte Notizen.'}),
                el('div', {class: 'rm-picker'},
                    el('span', {class: 'rm-picker-label', text: 'Projekt'}),
                    this.picker,
                    newBtn
                )
            ),
            this.banner
        );

        this.element = el('div', {class: 'rm-panel'}, header, this.kpis, this.emptyHint, this.tableWrap);
    }

    public async onShow(): Promise<void> {
        await this.loadProjects();
    }

    /**
     * React to a vault-change event (from the MCP event stream). When the AI
     * mutates the current project's roadmap via MCP, refetch so the live
     * cursor + table update without a manual reload. No-op when the panel is
     * hidden or the change is for another project — our own PUT saves adopt the
     * server result directly and don't need this path.
     */
    public onVaultEvent(touched: readonly string[]): void {
        if (this.project === null || this.saving) return;
        if (!document.body.contains(this.element)) return;
        if (touched.includes(`Memory/${this.project}/_roadmap.md`)) {
            void this.loadRoadmap();
        }
    }

    private async loadProjects(): Promise<void> {
        let summaries: RoadmapSummary[] = [];
        try {
            summaries = await api.listRoadmaps();
        } catch (e) {
            console.error('failed to list roadmaps', e);
        }
        this.projects = summaries.map((s) => s.project);

        clear(this.picker);
        if (this.projects.length === 0) {
            this.picker.appendChild(el('option', {text: '— keine Roadmap —', attrs: {value: ''}}));
        }
        for (const p of this.projects) {
            this.picker.appendChild(el('option', {text: p, attrs: {value: p}}));
        }

        // Keep the current selection if it still exists, else pick the first.
        if (this.project !== null && this.projects.includes(this.project)) {
            this.picker.value = this.project;
        } else {
            this.project = this.projects[0] ?? null;
            if (this.project !== null) this.picker.value = this.project;
        }

        if (this.project === null) {
            this.roadmap = null;
            this.renderEmpty('Noch keine Roadmap. Lege eine für ein Projekt an — oder lass die KI per MCP (synaipse_roadmap_plan) planen.');
            this.renderKpis(null);
            return;
        }
        await this.loadRoadmap();
    }

    private async onPickProject(): Promise<void> {
        this.project = this.picker.value || null;
        if (this.project === null) return;
        await this.loadRoadmap();
    }

    private async createProject(): Promise<void> {
        const name = window.prompt('Projektname (a-z, 0-9, . _ -):', '')?.trim();
        if (!name) return;
        if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
            window.alert('Ungültiger Projektname.');
            return;
        }
        this.project = name;
        this.roadmap = {project: name, updatedAt: '', active: null, steps: []};
        try {
            await api.putRoadmap(name, this.roadmap);
        } catch (e) {
            console.error('create roadmap failed', e);
        }
        await this.loadProjects();
    }

    private async loadRoadmap(): Promise<void> {
        if (this.project === null) return;
        try {
            this.roadmap = await api.getRoadmap(this.project);
        } catch (e) {
            console.error('failed to load roadmap', e);
            this.roadmap = {project: this.project, updatedAt: '', active: null, steps: []};
        }
        this.collapsed = this.loadCollapsed();
        this.render();
    }

    // --- collapse state (persisted per project) -----------------------------

    private collapseKey(): string | null {
        return this.project === null ? null : `synaipse.rm.collapsed.${this.project}`;
    }

    private loadCollapsed(): Set<string> {
        const key = this.collapseKey();
        if (key === null) return new Set();
        try {
            const raw = window.localStorage.getItem(key);
            if (raw === null) return new Set();
            const arr = JSON.parse(raw) as unknown;
            return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
        } catch {
            return new Set();
        }
    }

    private saveCollapsed(): void {
        const key = this.collapseKey();
        if (key === null) return;
        try {
            window.localStorage.setItem(key, JSON.stringify([...this.collapsed]));
        } catch {
            /* storage full/blocked — collapse is a convenience, ignore. */
        }
    }

    private toggleCollapse(id: string): void {
        if (this.collapsed.has(id)) this.collapsed.delete(id);
        else this.collapsed.add(id);
        this.saveCollapsed();
        this.render();
    }

    private collapseAll(collapse: boolean): void {
        this.collapsed = collapse && this.roadmap !== null
            ? new Set(parentIds(this.roadmap.steps))
            : new Set();
        this.saveCollapsed();
        this.render();
    }

    /** Fold everything except the path down to the live AI cursor, then scroll to it. */
    private focusActive(): void {
        const active = this.roadmap?.active?.stepId;
        if (this.roadmap === null || active === undefined || active === null) return;
        const keepOpen = new Set(ancestorsOf(this.roadmap.steps, active) ?? []);
        this.collapsed = new Set(parentIds(this.roadmap.steps).filter((id) => !keepOpen.has(id)));
        this.saveCollapsed();
        this.render();
        const row = this.tableWrap.querySelector(`tr[data-step="${CSS.escape(active)}"]`);
        row?.scrollIntoView({block: 'center', behavior: 'smooth'});
    }

    /** Clone → mutate → persist → adopt the server's rolled-up result. */
    private async mutate(fn: (rm: Roadmap) => void): Promise<void> {
        if (this.roadmap === null || this.project === null || this.saving) return;
        const draft: Roadmap = structuredClone(this.roadmap);
        fn(draft);
        this.roadmap = draft;
        this.render();
        this.saving = true;
        try {
            this.roadmap = await api.putRoadmap(this.project, draft);
        } catch (e) {
            console.error('save roadmap failed', e);
        } finally {
            this.saving = false;
            this.render();
        }
    }

    // --- rendering ----------------------------------------------------------

    private renderEmpty(message: string): void {
        clear(this.tableWrap);
        this.emptyHint.textContent = message;
        this.emptyHint.style.display = '';
        this.banner.style.display = 'none';
    }

    private renderKpis(rm: Roadmap | null): void {
        clear(this.kpis);
        if (rm === null) return;
        // KPIs always ignore soft-deleted steps.
        const rows = flatten(withoutDeleted(rm.steps));
        const total = rows.length;
        const blocked = rows.filter((r) => r.step.status === 'blocked').length;
        const leaves = rows.filter((r) => !r.step.children || r.step.children.length === 0);
        const planned = leaves.reduce((a, r) => a + (r.step.plannedHours ?? 0), 0);
        const actual = leaves.reduce((a, r) => a + (r.step.actualHours ?? 0), 0);
        const prog = leaves.length === 0
            ? 0
            : Math.round(leaves.reduce((a, r) => a + (r.step.progress ?? (r.step.status === 'done' ? 100 : 0)), 0) / leaves.length);

        const kpi = (label: string, value: string, bar?: number, warn = false): HTMLElement =>
            el('div', {class: warn ? 'rm-kpi warn' : 'rm-kpi'},
                el('div', {class: 'rm-kpi-k', text: label}),
                el('div', {class: 'rm-kpi-v', text: value}),
                bar !== undefined
                    ? el('div', {class: 'rm-kpi-bar'}, el('i', {style: {width: `${bar}%`}}))
                    : null
            );

        this.kpis.appendChild(kpi('Schritte', String(total)));
        this.kpis.appendChild(kpi('Fortschritt', `${prog}%`, prog));
        this.kpis.appendChild(kpi('Zeit geplant', fmtHours(Math.round(planned * 10) / 10)));
        this.kpis.appendChild(kpi('Zeit umgesetzt', fmtHours(Math.round(actual * 10) / 10), planned > 0 ? Math.min(100, Math.round((actual / planned) * 100)) : 0, actual > planned));
        this.kpis.appendChild(kpi('Blockiert', String(blocked), undefined, blocked > 0));
    }

    private renderBanner(rm: Roadmap): void {
        if (rm.active === null || rm.active === undefined) {
            this.banner.style.display = 'none';
            return;
        }
        const step = findStepLocal(rm.steps, rm.active.stepId);
        clear(this.banner);
        this.banner.style.display = '';
        this.banner.appendChild(el('div', {class: 'rm-banner-row'},
            el('span', {class: 'rm-pulse'}),
            el('span', {class: 'rm-banner-lbl', text: 'KI arbeitet gerade'})
        ));
        this.banner.appendChild(el('div', {class: 'rm-banner-what'},
            `Schritt ${rm.active.stepId}${step ? ` — ${step.title}` : ''}`
        ));
        if (rm.active.token) {
            this.banner.appendChild(el('div', {class: 'rm-banner-meta', text: `Token ${rm.active.token}`}));
        }
    }

    private render(): void {
        if (this.roadmap === null) {
            this.renderEmpty('Keine Roadmap geladen.');
            this.renderKpis(null);
            return;
        }
        const rm = this.roadmap;
        this.emptyHint.style.display = 'none';
        this.renderKpis(rm);
        this.renderBanner(rm);
        clear(this.tableWrap);

        const addRootBtn = el('button', {
            class: 'rm-btn',
            attrs: {type: 'button'},
            text: '＋ Schritt',
            on: {click: () => void this.addStep(null)}
        });
        const deletedCount = flatten(rm.steps).length - flatten(withoutDeleted(rm.steps)).length;
        const headChildren: (HTMLElement | null)[] = [
            el('h2', {text: 'Umsetzungsschritte'}),
            el('span', {class: 'rm-table-hint', text: 'verschachtelbar · Zeiten rollen auf Phasen auf'})
        ];

        // Fold controls — only worth showing once there is nesting to fold.
        if (parentIds(rm.steps).length > 0) {
            const fold = el('div', {class: 'rm-fold-ctl'},
                el('button', {class: 'rm-btn ghost sm', attrs: {type: 'button', title: 'Alle Unterschritte einklappen'}, text: '⊟ Einklappen', on: {click: () => this.collapseAll(true)}}),
                el('button', {class: 'rm-btn ghost sm', attrs: {type: 'button', title: 'Alle Unterschritte ausklappen'}, text: '⊞ Ausklappen', on: {click: () => this.collapseAll(false)}})
            );
            if (rm.active?.stepId) {
                fold.appendChild(el('button', {class: 'rm-btn ghost sm', attrs: {type: 'button', title: 'Nur den Pfad zum KI-Cursor öffnen und hinscrollen'}, text: '◉ Zum KI-Cursor', on: {click: () => this.focusActive()}}));
            }
            headChildren.push(fold);
        }
        if (deletedCount > 0) {
            const toggle = el('input', {attrs: {type: 'checkbox'}}) as HTMLInputElement;
            toggle.checked = this.showDeleted;
            toggle.addEventListener('change', () => {
                this.showDeleted = toggle.checked;
                this.render();
            });
            headChildren.push(el('label', {class: 'rm-deleted-toggle', attrs: {title: 'Gelöschte Schritte bleiben im Vault erhalten und lassen sich wiederherstellen.'}},
                toggle,
                el('span', {text: `🗑 Gelöschte anzeigen (${deletedCount})`})
            ));
        }
        headChildren.push(addRootBtn);
        this.tableWrap.appendChild(el('div', {class: 'rm-table-head'}, ...headChildren));

        const visibleSteps = this.showDeleted ? rm.steps : withoutDeleted(rm.steps);
        if (visibleSteps.length === 0) {
            const msg = rm.steps.length === 0
                ? 'Noch keine Schritte. „＋ Schritt" oben — oder die KI plant per MCP.'
                : 'Alle Schritte sind gelöscht (ausgeblendet). Schalte „Gelöschte anzeigen" ein.';
            this.tableWrap.appendChild(el('p', {class: 'rm-empty-inline', text: msg}));
            return;
        }

        const table = el('table', {class: 'rm-table'});
        table.appendChild(el('thead', {},
            el('tr', {},
                el('th', {text: 'Schritt'}),
                el('th', {text: 'Status'}),
                el('th', {text: 'Owner'}),
                el('th', {class: 'r', text: 'Geplant'}),
                el('th', {class: 'r', text: 'Umgesetzt'}),
                el('th', {class: 'r', text: 'Δ'}),
                el('th', {text: 'Fortschritt'}),
                el('th', {text: 'Notizen'}),
                el('th', {text: ''})
            )
        ));
        const tbody = el('tbody');
        for (const {step, depth, hiddenCount} of flattenCollapsed(visibleSteps, this.collapsed)) {
            tbody.appendChild(this.renderRow(step, depth, rm, hiddenCount));
            if (this.expanded.has(step.id)) {
                tbody.appendChild(this.renderDetail(step));
            }
        }
        table.appendChild(tbody);
        const scroll = el('div', {class: 'rm-scroll'}, table);
        this.tableWrap.appendChild(scroll);
    }

    private renderRow(step: RoadmapStep, depth: number, rm: Roadmap, hiddenCount = 0): HTMLElement {
        const isActive = rm.active?.stepId === step.id;
        const v = variance(step);
        // Every live step is expandable now — the detail row shows the full
        // (untruncated) title, the KI-Auswertung/Akzeptanz and an edit button.
        const expandable = !step.deleted;
        const hasChildren = Boolean(step.children && step.children.length > 0);
        const isCollapsed = hasChildren && this.collapsed.has(step.id);

        // First-column caret folds sub-steps (the navigation control for big
        // roadmaps). Detail (evaluation/activity) is reached via the name/ⓘ.
        const caret = el('span', {
            class: `rm-caret${hasChildren ? (isCollapsed ? ' collapsed' : ' open') : ' empty'}`,
            attrs: hasChildren ? {title: isCollapsed ? `Ausklappen (${hiddenCount} verborgen)` : 'Einklappen'} : {},
            on: hasChildren ? {click: () => this.toggleCollapse(step.id)} : {}
        },
            hasChildren ? el('span', {class: 'rm-caret-tw', text: isCollapsed ? '▸' : '▾'}) : null,
            isCollapsed && hiddenCount > 0 ? el('span', {class: 'rm-caret-badge', text: String(hiddenCount)}) : null
        );

        const statusSel = el('select', {
            class: `rm-status-select ${STATUS_CLASS[step.status]}`,
            on: {change: (e) => void this.changeStatus(step.id, (e.target as HTMLSelectElement).value as RoadmapStatus)}
        }) as HTMLSelectElement;
        for (const st of STATUS_ORDER) {
            const opt = el('option', {text: STATUS_LABEL[st], attrs: {value: st}}) as HTMLOptionElement;
            if (st === step.status) opt.selected = true;
            statusSel.appendChild(opt);
        }

        const owner = step.owner === 'ai' ? el('span', {class: 'rm-owner'}, el('span', {class: 'rm-av ai', text: 'KI'}), 'Claude')
            : step.owner === 'human' ? el('span', {class: 'rm-owner'}, el('span', {class: 'rm-av hu', text: '👤'}), 'Mensch')
                : el('span', {class: 'rm-owner muted', text: '—'});

        const prog = step.progress ?? (step.status === 'done' ? 100 : 0);

        const notes = el('div', {class: 'rm-notes'});
        for (const link of step.noteLinks ?? []) {
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

        const actions = step.deleted
            ? el('div', {class: 'rm-row-actions'},
                el('button', {class: 'rm-icon', attrs: {type: 'button', title: 'Wiederherstellen'}, text: '♻', on: {click: () => void this.restoreStep(step.id)}})
            )
            : el('div', {class: 'rm-row-actions'},
                el('button', {class: 'rm-icon', attrs: {type: 'button', title: 'KI-Cursor hier setzen'}, text: '◉', on: {click: () => void this.setActive(step.id)}}),
                el('button', {class: 'rm-icon', attrs: {type: 'button', title: 'Zeit buchen'}, text: '⏱', on: {click: () => void this.bookTime(step.id)}}),
                el('button', {class: 'rm-icon', attrs: {type: 'button', title: 'Notiz verlinken'}, text: '🔗', on: {click: () => void this.linkNote(step.id)}}),
                el('button', {class: 'rm-icon', attrs: {type: 'button', title: 'Unterschritt hinzufügen'}, text: '＋', on: {click: () => void this.addStep(step.id)}}),
                el('button', {class: 'rm-icon danger', attrs: {type: 'button', title: 'Als gelöscht markieren (ausblenden, wiederherstellbar)'}, text: '🗑', on: {click: () => void this.deleteStep(step.id)}})
            );

        const indent = el('span', {class: 'rm-indent', style: {width: `${depth * 20}px`}});
        const nameCls = `${depth === 0 ? 'rm-name lvl1' : 'rm-name'}${expandable ? ' has-detail' : ''}`;
        const stepCell = el('td', {class: 'rm-step-cell'},
            el('div', {class: 'rm-step'},
                indent,
                caret,
                el('code', {class: 'rm-id', text: step.id}),
                el('span', {
                    class: nameCls,
                    attrs: {title: expandable ? `${step.title} — klicken für Details` : step.title},
                    text: step.title,
                    on: expandable ? {click: () => this.toggleExpand(step.id)} : {}
                }),
                expandable
                    ? el('span', {class: `rm-detail-dot${this.expanded.has(step.id) ? ' open' : ''}`, attrs: {title: 'Details / Bearbeiten'}, text: 'ⓘ', on: {click: () => this.toggleExpand(step.id)}})
                    : null
            )
        );

        const rowCls = ['rm-row', isActive ? 'ai-row' : '', step.deleted ? 'rm-deleted' : ''].filter(Boolean).join(' ');
        return el('tr', {class: rowCls, attrs: {'data-step': step.id}},
            stepCell,
            el('td', {}, statusSel),
            el('td', {}, owner),
            el('td', {class: 'r num', text: fmtHours(step.plannedHours)}),
            el('td', {class: 'r num', text: fmtHours(step.actualHours)}),
            el('td', {class: `r num ${v.cls}`, text: v.text}),
            el('td', {}, el('div', {class: 'rm-prog'},
                el('span', {class: 'rm-track'}, el('i', {style: {width: `${prog}%`, ...(step.status === 'ai_active' ? {background: 'var(--rm-ai)'} : {})}})),
                el('span', {class: 'rm-pct num', text: `${prog}%`})
            )),
            el('td', {}, notes),
            el('td', {}, actions)
        );
    }

    private renderDetail(step: RoadmapStep): HTMLElement {
        const body = this.editing.has(step.id)
            ? this.renderDetailEdit(step)
            : this.renderDetailView(step);
        return el('tr', {class: 'rm-detail'}, el('td', {attrs: {colspan: '9'}},
            el('div', {class: 'rm-detail-wrap'}, ...body)
        ));
    }

    /** Read-only detail: full title header (+ edit button), evaluation, activity. */
    private renderDetailView(step: RoadmapStep): HTMLElement[] {
        // Full (untruncated) title — the table cell clips long titles, so the
        // detail area is where you read the whole thing.
        const head = el('div', {class: 'rm-detail-head'},
            el('code', {class: 'rm-id', text: step.id}),
            el('span', {class: 'rm-detail-title', text: step.title}),
            step.deleted
                ? null
                : el('button', {class: 'rm-btn ghost sm rm-detail-edit-btn', attrs: {type: 'button'}, text: '✎ Bearbeiten', on: {click: () => this.startEdit(step.id)}})
        );

        const boxes: HTMLElement[] = [];
        if (step.evaluation || step.acceptance) {
            const box = el('div', {class: 'rm-detail-box'}, el('h4', {text: 'KI-Auswertung'}));
            if (step.evaluation) box.appendChild(el('p', {class: 'rm-quote', text: step.evaluation}));
            if (step.acceptance) box.appendChild(el('p', {}, el('b', {text: 'Akzeptanz: '}), step.acceptance));
            boxes.push(box);
        }
        if (step.activity && step.activity.length > 0) {
            const box = el('div', {class: 'rm-detail-box'}, el('h4', {text: 'Aktivität'}));
            const log = el('ul', {class: 'rm-log'});
            for (const ev of [...step.activity].reverse()) {
                const when = ev.at ? new Date(ev.at).toLocaleString('de-DE', {hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'}) : '';
                log.appendChild(el('li', {},
                    el('span', {class: 'rm-log-t', text: when}),
                    el('span', {}, el('span', {class: 'rm-log-who', text: ev.who}), ` ${ev.what}`)
                ));
            }
            box.appendChild(log);
            boxes.push(box);
        }
        if (boxes.length === 0) {
            boxes.push(el('div', {class: 'rm-detail-box'}, el('p', {class: 'rm-detail-empty', text: 'Noch keine Auswertung/Akzeptanz. „✎ Bearbeiten" fügt sie hinzu.'})));
        }
        return [head, el('div', {class: 'rm-detail-inner'}, ...boxes)];
    }

    /** Edit form: title, evaluation, acceptance — persisted via mutate(). */
    private renderDetailEdit(step: RoadmapStep): HTMLElement[] {
        const titleInput = el('input', {class: 'rm-edit-input', attrs: {type: 'text', value: step.title, placeholder: 'Titel'}}) as HTMLInputElement;
        const evalArea = el('textarea', {class: 'rm-edit-area', attrs: {rows: '4', placeholder: 'KI-Auswertung / Rationale …'}}) as HTMLTextAreaElement;
        evalArea.value = step.evaluation ?? '';
        const accArea = el('textarea', {class: 'rm-edit-area', attrs: {rows: '2', placeholder: 'Akzeptanzkriterien (Definition of Done) …'}}) as HTMLTextAreaElement;
        accArea.value = step.acceptance ?? '';

        const save = (): void => void this.saveEdit(step.id, {
            title: titleInput.value.trim(),
            evaluation: evalArea.value,
            acceptance: accArea.value
        });

        const field = (label: string, control: HTMLElement): HTMLElement =>
            el('label', {class: 'rm-edit-field'}, el('span', {class: 'rm-edit-lbl', text: label}), control);

        const head = el('div', {class: 'rm-detail-head'},
            el('code', {class: 'rm-id', text: step.id}),
            el('span', {class: 'rm-detail-title muted', text: 'Bearbeiten'})
        );
        const form = el('div', {class: 'rm-detail-editform'},
            field('Titel', titleInput),
            field('KI-Auswertung', evalArea),
            field('Akzeptanz', accArea),
            el('div', {class: 'rm-edit-actions'},
                el('button', {class: 'rm-btn sm', attrs: {type: 'button'}, text: 'Speichern', on: {click: save}}),
                el('button', {class: 'rm-btn ghost sm', attrs: {type: 'button'}, text: 'Abbrechen', on: {click: () => this.cancelEdit(step.id)}})
            )
        );
        return [head, form];
    }

    private toggleExpand(id: string): void {
        if (this.expanded.has(id)) {
            this.expanded.delete(id);
            this.editing.delete(id);
        } else {
            this.expanded.add(id);
        }
        this.render();
    }

    private startEdit(id: string): void {
        this.expanded.add(id);
        this.editing.add(id);
        this.render();
    }

    private cancelEdit(id: string): void {
        this.editing.delete(id);
        this.render();
    }

    private async saveEdit(id: string, fields: {title: string; evaluation: string; acceptance: string}): Promise<void> {
        this.editing.delete(id);
        await this.mutate((rm) => {
            const s = findStepLocal(rm.steps, id);
            if (!s) return;
            if (fields.title.length > 0) s.title = fields.title;
            if (fields.evaluation.trim().length > 0) s.evaluation = fields.evaluation.trim();
            else delete s.evaluation;
            if (fields.acceptance.trim().length > 0) s.acceptance = fields.acceptance.trim();
            else delete s.acceptance;
        });
    }

    // --- mutations ----------------------------------------------------------

    private async addStep(parentId: string | null): Promise<void> {
        const title = window.prompt(parentId === null ? 'Neuer Schritt — Titel:' : 'Neuer Unterschritt — Titel:', '')?.trim();
        if (!title) return;
        await this.mutate((rm) => {
            const id = nextId(rm.steps, parentId);
            const step: RoadmapStep = {id, title, status: 'planned'};
            if (parentId === null) {
                rm.steps.push(step);
            } else {
                const parent = findStepLocal(rm.steps, parentId);
                if (parent) {
                    parent.children = [...(parent.children ?? []), step];
                }
            }
        });
    }

    private async changeStatus(id: string, status: RoadmapStatus): Promise<void> {
        await this.mutate((rm) => {
            const step = findStepLocal(rm.steps, id);
            if (step) step.status = status;
        });
    }

    private async setActive(id: string): Promise<void> {
        // Clear when the step is already the active one; else set it.
        const already = this.roadmap?.active?.stepId === id;
        await this.mutate((rm) => {
            const clearOld = (steps: RoadmapStep[]): void => {
                for (const s of steps) {
                    if (s.status === 'ai_active') s.status = 'in_progress';
                    if (s.children) clearOld(s.children);
                }
            };
            clearOld(rm.steps);
            if (already) {
                rm.active = null;
            } else {
                const step = findStepLocal(rm.steps, id);
                if (step) {
                    step.status = 'ai_active';
                    rm.active = {stepId: id, since: new Date().toISOString(), token: 'web'};
                }
            }
        });
    }

    private async bookTime(id: string): Promise<void> {
        const step = findStepLocal(this.roadmap?.steps ?? [], id);
        if (!step) return;
        const planned = window.prompt('Geplante Zeit (h):', step.plannedHours !== undefined ? String(step.plannedHours) : '');
        if (planned === null) return;
        const actual = window.prompt('Umgesetzte Zeit (h):', step.actualHours !== undefined ? String(step.actualHours) : '');
        if (actual === null) return;
        await this.mutate((rm) => {
            const s = findStepLocal(rm.steps, id);
            if (!s) return;
            const p = Number.parseFloat(planned);
            const a = Number.parseFloat(actual);
            if (Number.isFinite(p)) s.plannedHours = p;
            if (Number.isFinite(a)) s.actualHours = a;
        });
    }

    private async linkNote(id: string): Promise<void> {
        const target = window.prompt('Notiz-Titel oder Pfad verlinken:', '')?.trim();
        if (!target) return;
        await this.mutate((rm) => {
            const s = findStepLocal(rm.steps, id);
            if (!s) return;
            const have = new Set(s.noteLinks ?? []);
            if (!have.has(target)) s.noteLinks = [...(s.noteLinks ?? []), target];
        });
    }

    /**
     * Soft-delete a step: it is marked `deleted` (cascading to sub-steps) and
     * hidden, but kept in the vault so it stays reversible. Steps are never
     * hard-removed from the roadmap.
     */
    private async deleteStep(id: string): Promise<void> {
        if (!window.confirm('Schritt als gelöscht markieren? Er wird ausgeblendet, bleibt aber im Vault erhalten und lässt sich wiederherstellen.')) return;
        await this.mutate((rm) => {
            rm.steps = setStepDeleted(rm.steps, id, true);
        });
    }

    /** Restore a soft-deleted step (and its sub-steps). */
    private async restoreStep(id: string): Promise<void> {
        await this.mutate((rm) => {
            rm.steps = setStepDeleted(rm.steps, id, false);
        });
    }
}
