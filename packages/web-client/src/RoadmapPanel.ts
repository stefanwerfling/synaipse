import type {Roadmap, RoadmapStatus, RoadmapStep, RoadmapSummary} from '@synaipse/core';
import {setStepDeleted, withoutDeleted} from '@synaipse/core';
import {api} from './Api.js';
import {clear, el} from './Dom.js';
import {confirmDialog, formDialog, promptDialog, validProjectName} from './Dialogs.js';
import {defineMessages, formatDateTime, formatNumber, tc} from './I18n.js';
import type {RoadmapGraph} from './RoadmapGraph.js';
import {toast} from './Toast.js';

const t = defineMessages('roadmapPanel', {
    statusBacklog: 'Backlog',
    statusPlanned: 'Planned',
    statusInProgress: 'In progress',
    statusAiActive: 'AI active',
    statusReview: 'Review',
    statusBlocked: 'Blocked',
    statusDone: 'Done',
    statusCancelled: 'Cancelled',
    hours: '{hours} h',
    newProjectTitle: 'Create a roadmap for a new project',
    newProjectBtn: '＋ Project',
    title: 'Roadmap',
    subtitle: 'AI-planned implementation steps per project — status, time planned/spent, linked notes.',
    project: 'Project',
    pickProjectFirst: 'Create or select a project first.',
    noRoadmapOption: '— no roadmap —',
    noRoadmapYet: 'No roadmap yet. Create one for a project — or let the AI plan it via MCP (synaipse_roadmap_plan).',
    newProject: 'New project',
    projectName: 'Project name (a-z, 0-9, . _ -)',
    kpiSteps: 'Steps',
    kpiProgress: 'Progress',
    kpiPlanned: 'Time planned',
    kpiActual: 'Time spent',
    kpiBlocked: 'Blocked',
    aiWorking: 'AI is working',
    activeStep: 'Step {id}',
    activeStepTitled: 'Step {id} — {title}',
    token: 'Token {token}',
    noRoadmapLoaded: 'No roadmap loaded.',
    addStepBtn: '＋ Step',
    stepsHeading: 'Implementation steps',
    tableHint: 'nestable · times roll up into phases',
    collapseAllTitle: 'Collapse all sub-steps',
    collapseAll: '⊟ Collapse',
    expandAllTitle: 'Expand all sub-steps',
    expandAll: '⊞ Expand',
    focusActiveTitle: 'Open only the path to the AI cursor and scroll to it',
    focusActive: '◉ To AI cursor',
    deletedToggleTitle: 'Deleted steps stay in the vault and can be restored.',
    showDeleted: '🗑 Show deleted ({count})',
    noSteps: 'No steps yet. “＋ Step” above — or the AI plans via MCP.',
    allDeleted: 'All steps are deleted (hidden). Turn on “Show deleted”.',
    colStep: 'Step',
    colStatus: 'Status',
    colOwner: 'Owner',
    colPlanned: 'Planned',
    colActual: 'Spent',
    colProgress: 'Progress',
    colNotes: 'Notes',
    expandHidden: 'Expand ({count} hidden)',
    collapse: 'Collapse',
    ownerAiAvatar: 'AI',
    ownerHuman: 'Human',
    restore: 'Restore',
    setCursor: 'Set the AI cursor here',
    bookTime: 'Book time',
    linkNote: 'Link note',
    addSubStep: 'Add sub-step',
    markDeleted: 'Mark as deleted (hidden, restorable)',
    clickForDetails: '{title} — click for details',
    detailsEdit: 'Details / Edit',
    editBtn: '✎ Edit',
    evaluation: 'AI evaluation',
    acceptanceLabel: 'Acceptance: ',
    activity: 'Activity',
    noEvaluation: 'No evaluation/acceptance yet. “✎ Edit” adds them.',
    titleLabel: 'Title',
    evaluationPlaceholder: 'AI evaluation / rationale …',
    acceptancePlaceholder: 'Acceptance criteria (definition of done) …',
    acceptance: 'Acceptance',
    newStep: 'New step',
    newSubStep: 'New sub-step',
    plannedHours: 'Planned (h)',
    actualHours: 'Spent (h)',
    hoursInvalid: 'Enter hours as a number (leave empty to keep unchanged).',
    noteRef: 'Title, alias or path',
    noteRefPlaceholder: 'e.g. Memory/project/note.md',
    link: 'Link',
    noteNotFound: 'No note found for “{ref}”. Use the exact title, alias or path.',
    deleteStepTitle: 'Delete step?',
    deleteStepMessage: 'The step is marked as deleted and hidden. It stays in the vault and can be restored.',
    viewLabel: 'View',
    viewTable: 'Table',
    viewGraph: 'Dependencies'
});

export interface RoadmapPanelOptions {
    /** Open a linked note in the Notes tab. */
    onOpenNote?: (noteId: string) => void;
    /**
     * Resolve a user-entered note reference (title / alias / path / id) to the
     * canonical string to store, or null when it matches no note. Lets the
     * panel reject dead links at creation time instead of persisting them.
     */
    resolveNoteLink?: (ref: string) => string | null;
    /** The shown project changed: the app keeps the URL in step. */
    onProjectChange?: (project: string | null) => void;
}

const STATUS_ORDER: RoadmapStatus[] = [
    'backlog', 'planned', 'in_progress', 'ai_active', // i18n: id
    'review', 'blocked', 'done', 'cancelled' // i18n: id
];

const VIEW_KEY = 'synaipse.rm.view';

const readView = (): 'table' | 'graph' => {
    try {
        return window.localStorage.getItem(VIEW_KEY) === 'graph' ? 'graph' : 'table';
    } catch {
        return 'table';
    }
};

const writeView = (view: 'table' | 'graph'): void => {
    try {
        window.localStorage.setItem(VIEW_KEY, view);
    } catch {
        // private mode: the view just is not remembered
    }
};

const STATUS_LABEL_KEY = {
    backlog: 'statusBacklog',
    planned: 'statusPlanned',
    in_progress: 'statusInProgress',
    ai_active: 'statusAiActive',
    review: 'statusReview',
    blocked: 'statusBlocked',
    done: 'statusDone',
    cancelled: 'statusCancelled'
} as const satisfies Record<RoadmapStatus, string>;

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
    n === undefined ? '—' : t('hours', {hours: formatNumber(n)});

/** Delta between planned and actual, as a signed string plus a CSS class. */
const variance = (step: RoadmapStep): {text: string; cls: string} => {
    if (step.plannedHours === undefined || step.actualHours === undefined) {
        return {text: '—', cls: 'rm-var-none'};
    }
    const d = Math.round((step.actualHours - step.plannedHours) * 10) / 10;
    if (d === 0) return {text: '0', cls: 'rm-var-none'};
    return d > 0
        ? {text: `+${formatNumber(d)}`, cls: 'rm-var-over'}
        : {text: formatNumber(d), cls: 'rm-var-under'};
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
    /** Table or dependency graph (plan P10 / S4), remembered in this browser. */
    private view: 'table' | 'graph' = readView();
    private graphView: RoadmapGraph | null = null;
    private graphSelected: string | null = null;
    private readonly graphDetail = el('div', {class: 'rm-graph-detail'});

    public constructor(opts: RoadmapPanelOptions = {}) {
        this.opts = opts;

        this.picker = el('select', {class: 'rm-picker-select', on: {change: () => void this.onPickProject()}}) as HTMLSelectElement;

        const newBtn = el('button', {
            class: 'rm-btn ghost',
            attrs: {type: 'button', title: t('newProjectTitle')},
            text: t('newProjectBtn'),
            on: {click: () => void this.createProject()}
        });

        this.banner = el('div', {class: 'rm-banner', style: {display: 'none'}});
        this.kpis = el('div', {class: 'rm-kpis'});
        this.tableWrap = el('div', {class: 'rm-table-wrap'});
        this.emptyHint = el('div', {class: 'rm-empty', style: {display: 'none'}});

        const header = el('div', {class: 'rm-head'},
            el('div', {class: 'rm-head-left'},
                el('h1', {class: 'rm-title', text: t('title')}),
                el('p', {class: 'rm-sub', text: t('subtitle')}),
                el('div', {class: 'rm-picker'},
                    el('span', {class: 'rm-picker-label', text: t('project')}),
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

    /** The project on screen, null when there is none. */
    public currentProject(): string | null {
        return this.project;
    }

    /**
     * Show this project (a route or the palette). Unknown names fall back to
     * the first project when the list loads.
     */
    public async selectProject(name: string): Promise<void> {
        if (this.project === name && this.roadmap?.project === name) return;
        this.project = name;
        if (this.element.isConnected) await this.loadProjects();
    }

    /** Palette: create a project. */
    public newProject(): Promise<void> {
        return this.createProject();
    }

    /** Palette: add a top-level step to the shown project. */
    public async newStep(): Promise<void> {
        if (this.project === null || this.roadmap === null) {
            toast(t('pickProjectFirst'), {kind: 'info'});
            return;
        }
        await this.addStep(null);
    }

    private notifiedProject: string | null | undefined = undefined;

    private notifyProject(): void {
        if (this.notifiedProject === this.project) return;
        this.notifiedProject = this.project;
        this.opts.onProjectChange?.(this.project);
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
        if (!this.element.isConnected) return;
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
            this.picker.appendChild(el('option', {text: t('noRoadmapOption'), attrs: {value: ''}}));
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
            this.notifyProject();
            this.renderEmpty(t('noRoadmapYet'));
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
        const name = await promptDialog({
            title: t('newProject'),
            label: t('projectName'),
            confirmLabel: tc('create'),
            cancelLabel: tc('cancel'),
            validate: validProjectName
        });
        if (!name) return;
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
        this.notifyProject();
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

        this.kpis.appendChild(kpi(t('kpiSteps'), String(total)));
        this.kpis.appendChild(kpi(t('kpiProgress'), `${prog}%`, prog));
        this.kpis.appendChild(kpi(t('kpiPlanned'), fmtHours(Math.round(planned * 10) / 10)));
        this.kpis.appendChild(kpi(t('kpiActual'), fmtHours(Math.round(actual * 10) / 10), planned > 0 ? Math.min(100, Math.round((actual / planned) * 100)) : 0, actual > planned));
        this.kpis.appendChild(kpi(t('kpiBlocked'), String(blocked), undefined, blocked > 0));
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
            el('span', {class: 'rm-banner-lbl', text: t('aiWorking')})
        ));
        this.banner.appendChild(el('div', {class: 'rm-banner-what'},
            step ? t('activeStepTitled', {id: rm.active.stepId, title: step.title}) : t('activeStep', {id: rm.active.stepId})
        ));
        if (rm.active.token) {
            this.banner.appendChild(el('div', {class: 'rm-banner-meta', text: t('token', {token: rm.active.token})}));
        }
    }

    private render(): void {
        if (this.roadmap === null) {
            this.renderEmpty(t('noRoadmapLoaded'));
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
            text: t('addStepBtn'),
            on: {click: () => void this.addStep(null)}
        });
        const deletedCount = flatten(rm.steps).length - flatten(withoutDeleted(rm.steps)).length;
        const headChildren: (HTMLElement | null)[] = [
            el('h2', {text: t('stepsHeading')}),
            this.renderViewSwitch(),
            this.view === 'table' ? el('span', {class: 'rm-table-hint', text: t('tableHint')}) : null
        ];

        // Fold controls — only worth showing once there is nesting to fold.
        if (this.view === 'table' && parentIds(rm.steps).length > 0) {
            const fold = el('div', {class: 'rm-fold-ctl'},
                el('button', {class: 'rm-btn ghost sm', attrs: {type: 'button', title: t('collapseAllTitle')}, text: t('collapseAll'), on: {click: () => this.collapseAll(true)}}),
                el('button', {class: 'rm-btn ghost sm', attrs: {type: 'button', title: t('expandAllTitle')}, text: t('expandAll'), on: {click: () => this.collapseAll(false)}})
            );
            if (rm.active?.stepId) {
                fold.appendChild(el('button', {class: 'rm-btn ghost sm', attrs: {type: 'button', title: t('focusActiveTitle')}, text: t('focusActive'), on: {click: () => this.focusActive()}}));
            }
            headChildren.push(fold);
        }
        if (this.view === 'table' && deletedCount > 0) {
            const toggle = el('input', {attrs: {type: 'checkbox'}}) as HTMLInputElement;
            toggle.checked = this.showDeleted;
            toggle.addEventListener('change', () => {
                this.showDeleted = toggle.checked;
                this.render();
            });
            headChildren.push(el('label', {class: 'rm-deleted-toggle', attrs: {title: t('deletedToggleTitle')}},
                toggle,
                el('span', {text: t('showDeleted', {count: deletedCount})})
            ));
        }
        headChildren.push(addRootBtn);
        this.tableWrap.appendChild(el('div', {class: 'rm-table-head'}, ...headChildren));

        if (this.view === 'graph') {
            void this.renderGraph(rm);
            return;
        }

        const visibleSteps = this.showDeleted ? rm.steps : withoutDeleted(rm.steps);
        if (visibleSteps.length === 0) {
            const msg = rm.steps.length === 0
                ? t('noSteps')
                : t('allDeleted');
            this.tableWrap.appendChild(el('p', {class: 'rm-empty-inline', text: msg}));
            return;
        }

        const table = el('table', {class: 'rm-table'});
        table.appendChild(el('thead', {},
            el('tr', {},
                el('th', {text: t('colStep')}),
                el('th', {text: t('colStatus')}),
                el('th', {text: t('colOwner')}),
                el('th', {class: 'r', text: t('colPlanned')}),
                el('th', {class: 'r', text: t('colActual')}),
                el('th', {class: 'r', text: 'Δ'}),
                el('th', {text: t('colProgress')}),
                el('th', {text: t('colNotes')}),
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

    private renderViewSwitch(): HTMLElement {
        const option = (view: 'table' | 'graph', label: string): HTMLElement => el('button', {
            class: this.view === view ? 'rm-view-btn active' : 'rm-view-btn',
            attrs: {type: 'button', 'aria-pressed': this.view === view ? 'true' : 'false'},
            text: label,
            on: {click: () => {
                if (this.view === view) return;
                this.view = view;
                writeView(view);
                if (view === 'table') this.graphView?.detach();
                this.render();
            }}
        });
        return el('div', {class: 'rm-view-switch', attrs: {role: 'group', 'aria-label': t('viewLabel')}},
            option('table', t('viewTable')),
            option('graph', t('viewGraph'))
        );
    }

    /** Dependency graph of the visible steps; the graph chunk loads on first use. */
    private async renderGraph(rm: Roadmap): Promise<void> {
        const steps = withoutDeleted(rm.steps);
        if (steps.length === 0) {
            this.tableWrap.appendChild(el('p', {class: 'rm-empty-inline', text: rm.steps.length === 0 ? t('noSteps') : t('allDeleted')}));
            return;
        }
        if (this.graphView === null) {
            const {RoadmapGraph} = await import('./RoadmapGraph.js');
            this.graphView ??= new RoadmapGraph({
                statusLabel: (status) => t(STATUS_LABEL_KEY[status]),
                onSelect: (id) => {
                    this.graphSelected = this.graphSelected === id ? null : id;
                    this.renderGraphDetail();
                }
            });
        }
        // The table may have taken over while the chunk loaded.
        if (this.view !== 'graph' || this.roadmap !== rm) return;
        this.tableWrap.append(this.graphView.element, this.graphDetail);
        this.graphView.update(rm.project, steps, rm.active?.stepId ?? null);
        this.renderGraphDetail();
    }

    /** Detail of the step clicked in the graph: the same view and editor as the table row. */
    private renderGraphDetail(): void {
        clear(this.graphDetail);
        const step = this.graphSelected === null || this.roadmap === null
            ? undefined
            : flatten(this.roadmap.steps).find((row) => row.step.id === this.graphSelected)?.step;
        if (step === undefined) return;
        const body = this.editing.has(step.id) ? this.renderDetailEdit(step) : this.renderDetailView(step);
        this.graphDetail.appendChild(el('div', {class: 'rm-detail-wrap'}, ...body));
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
            attrs: hasChildren ? {title: isCollapsed ? t('expandHidden', {count: hiddenCount}) : t('collapse')} : {},
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
            const opt = el('option', {text: t(STATUS_LABEL_KEY[st]), attrs: {value: st}}) as HTMLOptionElement;
            if (st === step.status) opt.selected = true;
            statusSel.appendChild(opt);
        }

        const owner = step.owner === 'ai' ? el('span', {class: 'rm-owner'}, el('span', {class: 'rm-av ai', text: t('ownerAiAvatar')}), 'Claude')
            : step.owner === 'human' ? el('span', {class: 'rm-owner'}, el('span', {class: 'rm-av hu', text: '👤'}), t('ownerHuman'))
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
                el('button', {class: 'rm-icon', attrs: {type: 'button', title: t('restore'), 'aria-label': t('restore')}, text: '♻', on: {click: () => void this.restoreStep(step.id)}})
            )
            : el('div', {class: 'rm-row-actions'},
                el('button', {class: 'rm-icon', attrs: {type: 'button', title: t('setCursor'), 'aria-label': t('setCursor')}, text: '◉', on: {click: () => void this.setActive(step.id)}}),
                el('button', {class: 'rm-icon', attrs: {type: 'button', title: t('bookTime'), 'aria-label': t('bookTime')}, text: '⏱', on: {click: () => void this.bookTime(step.id)}}),
                el('button', {class: 'rm-icon', attrs: {type: 'button', title: t('linkNote'), 'aria-label': t('linkNote')}, text: '🔗', on: {click: () => void this.linkNote(step.id)}}),
                el('button', {class: 'rm-icon', attrs: {type: 'button', title: t('addSubStep'), 'aria-label': t('addSubStep')}, text: '＋', on: {click: () => void this.addStep(step.id)}}),
                el('button', {class: 'rm-icon danger', attrs: {type: 'button', title: t('markDeleted'), 'aria-label': t('markDeleted')}, text: '🗑', on: {click: () => void this.deleteStep(step.id)}})
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
                    attrs: {title: expandable ? t('clickForDetails', {title: step.title}) : step.title},
                    text: step.title,
                    on: expandable ? {click: () => this.toggleExpand(step.id)} : {}
                }),
                expandable
                    ? el('span', {class: `rm-detail-dot${this.expanded.has(step.id) ? ' open' : ''}`, attrs: {title: t('detailsEdit')}, text: 'ⓘ', on: {click: () => this.toggleExpand(step.id)}})
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
                : el('button', {class: 'rm-btn ghost sm rm-detail-edit-btn', attrs: {type: 'button'}, text: t('editBtn'), on: {click: () => this.startEdit(step.id)}})
        );

        const boxes: HTMLElement[] = [];
        if (step.evaluation || step.acceptance) {
            const box = el('div', {class: 'rm-detail-box'}, el('h4', {text: t('evaluation')}));
            if (step.evaluation) box.appendChild(el('p', {class: 'rm-quote', text: step.evaluation}));
            if (step.acceptance) box.appendChild(el('p', {}, el('b', {text: t('acceptanceLabel')}), step.acceptance));
            boxes.push(box);
        }
        if (step.activity && step.activity.length > 0) {
            const box = el('div', {class: 'rm-detail-box'}, el('h4', {text: t('activity')}));
            const log = el('ul', {class: 'rm-log'});
            for (const ev of [...step.activity].reverse()) {
                const when = ev.at ? formatDateTime(ev.at, {hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'}) : '';
                log.appendChild(el('li', {},
                    el('span', {class: 'rm-log-t', text: when}),
                    el('span', {}, el('span', {class: 'rm-log-who', text: ev.who}), ` ${ev.what}`)
                ));
            }
            box.appendChild(log);
            boxes.push(box);
        }
        if (boxes.length === 0) {
            boxes.push(el('div', {class: 'rm-detail-box'}, el('p', {class: 'rm-detail-empty', text: t('noEvaluation')})));
        }
        return [head, el('div', {class: 'rm-detail-inner'}, ...boxes)];
    }

    /** Edit form: title, evaluation, acceptance — persisted via mutate(). */
    private renderDetailEdit(step: RoadmapStep): HTMLElement[] {
        const titleInput = el('input', {class: 'rm-edit-input', attrs: {type: 'text', value: step.title, placeholder: t('titleLabel')}}) as HTMLInputElement;
        const evalArea = el('textarea', {class: 'rm-edit-area', attrs: {rows: '4', placeholder: t('evaluationPlaceholder')}}) as HTMLTextAreaElement;
        evalArea.value = step.evaluation ?? '';
        const accArea = el('textarea', {class: 'rm-edit-area', attrs: {rows: '2', placeholder: t('acceptancePlaceholder')}}) as HTMLTextAreaElement;
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
            el('span', {class: 'rm-detail-title muted', text: tc('edit')})
        );
        const form = el('div', {class: 'rm-detail-editform'},
            field(t('titleLabel'), titleInput),
            field(t('evaluation'), evalArea),
            field(t('acceptance'), accArea),
            el('div', {class: 'rm-edit-actions'},
                el('button', {class: 'rm-btn sm', attrs: {type: 'button'}, text: tc('save'), on: {click: save}}),
                el('button', {class: 'rm-btn ghost sm', attrs: {type: 'button'}, text: tc('cancel'), on: {click: () => this.cancelEdit(step.id)}})
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
        const title = await promptDialog({
            title: parentId === null ? t('newStep') : t('newSubStep'),
            label: t('titleLabel'),
            confirmLabel: tc('create'),
            cancelLabel: tc('cancel')
        });
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
        const hours = await formDialog({
            title: t('bookTime'),
            message: step.title,
            fields: [
                {name: 'planned', label: t('plannedHours'), type: 'number', value: step.plannedHours !== undefined ? String(step.plannedHours) : ''},
                {name: 'actual', label: t('actualHours'), type: 'number', value: step.actualHours !== undefined ? String(step.actualHours) : ''}
            ],
            confirmLabel: tc('save'),
            cancelLabel: tc('cancel'),
            validate: (v) => [v.planned!, v.actual!].some((x) => x !== '' && !Number.isFinite(Number.parseFloat(x)))
                ? t('hoursInvalid')
                : null
        });
        if (hours === null) return;
        const planned = hours.planned!;
        const actual = hours.actual!;
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
        // Resolve to an existing note before storing, so no dead links are created.
        const resolve = this.opts.resolveNoteLink;
        const raw = await promptDialog({
            title: t('linkNote'),
            label: t('noteRef'),
            placeholder: t('noteRefPlaceholder'),
            confirmLabel: t('link'),
            cancelLabel: tc('cancel'),
            validate: (v) => v !== '' && resolve !== undefined && resolve(v) === null
                ? t('noteNotFound', {ref: v})
                : null
        });
        if (!raw) return;
        const canonical = resolve ? resolve(raw) : raw;
        if (canonical === null) return;
        await this.mutate((rm) => {
            const s = findStepLocal(rm.steps, id);
            if (!s) return;
            const have = new Set(s.noteLinks ?? []);
            if (!have.has(canonical)) s.noteLinks = [...(s.noteLinks ?? []), canonical];
        });
    }

    /**
     * Soft-delete a step: it is marked `deleted` (cascading to sub-steps) and
     * hidden, but kept in the vault so it stays reversible. Steps are never
     * hard-removed from the roadmap.
     */
    private async deleteStep(id: string): Promise<void> {
        const ok = await confirmDialog({
            title: t('deleteStepTitle'),
            message: t('deleteStepMessage'),
            confirmLabel: tc('delete'),
            cancelLabel: tc('cancel'),
            danger: true
        });
        if (!ok) return;
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
