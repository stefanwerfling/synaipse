import type {RoadmapStatus, RoadmapStep} from '@synaipse/core';
import type {NGraph, NGraphEdgeData, NGraphHull, NGraphNodeData, NodeStatus} from 'jsngraph';
import {clear, el} from './Dom.js';
import {loadJsNGraph, readGraphTheme, type JsNGraph} from './GraphStyle.js';
import {defineMessages} from './I18n.js';
import {buildRoadmapDag, phaseIds, type DagNode} from './RoadmapDag.js';
import {readItem, writeItem} from './LocalStore.js';

/**
 * Roadmap as a dependency graph (plan P10 / S4): steps as cards in
 * dependency columns (jsNGraph LayeredLayout), `dependsOn` as arrows.
 * Phases start closed and open with a double click; open phases are hulls
 * around their steps. Which phases are open is remembered per project.
 */

const t = defineMessages('roadmapGraph', {
    hint: 'Double-click a phase to open or close it · click a step for details · drag to pan, wheel to zoom',
    openAll: 'Open all phases',
    closeAll: 'Close all phases',
    fit: 'Fit',
    fitTitle: 'Fit to view',
    hidden: '▸ {count} step|▸ {count} steps',
    progress: '{status} · {progress} %',
    noDeps: 'No dependencies at this level yet: steps get them via dependsOn (MCP roadmap tools).',
    loading: 'loading graph…',
    failed: 'Graph unavailable: {message}'
});

/** Status → design token; planned and cancelled share the backlog grey. */
const STATUS_TOKEN: Record<RoadmapStatus, string> = {
    backlog: '--rm-backlog',
    planned: '--rm-backlog',
    in_progress: '--rm-prog',
    ai_active: '--rm-ai',
    review: '--rm-review',
    blocked: '--rm-blocked',
    done: '--rm-done',
    cancelled: '--rm-backlog'
};

/** The card's status dot: done green, under way amber, blocked red, not started grey. */
const STATUS_DOT: Record<RoadmapStatus, NodeStatus> = {
    backlog: 'down',
    planned: 'down',
    in_progress: 'warning',
    ai_active: 'warning',
    review: 'warning',
    blocked: 'critical',
    done: 'ok',
    cancelled: 'down'
};

const LABEL_MAX = 26;

export interface RoadmapGraphOptions {
    statusLabel: (status: RoadmapStatus) => string;
    onSelect: (stepId: string) => void;
}

export class RoadmapGraph {
    public readonly element: HTMLElement;
    private readonly stage: HTMLElement;
    private readonly note: HTMLElement;
    private graph: NGraph | null = null;
    private lib: JsNGraph | null = null;
    private open = new Set<string>();
    private project: string | null = null;
    private steps: readonly RoadmapStep[] = [];
    private activeId: string | null = null;
    private fitPending = true;

    public constructor(private readonly opts: RoadmapGraphOptions) {
        this.stage = el('div', {class: 'rm-graph-stage'});
        this.note = el('p', {class: 'rm-graph-note'});
        const button = (text: string, title: string, click: () => void): HTMLElement =>
            el('button', {class: 'rm-btn ghost sm', attrs: {type: 'button', title}, text, on: {click}});
        this.element = el('div', {class: 'rm-graph'},
            el('div', {class: 'rm-graph-bar'},
                el('span', {class: 'rm-table-hint', text: t('hint')}),
                el('div', {class: 'rm-fold-ctl'},
                    button(t('closeAll'), t('closeAll'), () => this.setOpen(new Set())),
                    button(t('openAll'), t('openAll'), () => this.setOpen(new Set(phaseIds(this.steps)))),
                    button(t('fit'), t('fitTitle'), () => this.graph?.fit({maxScale: 1.4, padding: 40}))
                )
            ),
            this.stage,
            this.note
        );
    }

    /** Show a project's steps (deleted ones already removed). */
    public update(project: string, steps: readonly RoadmapStep[], activeId: string | null): void {
        if (project !== this.project) {
            this.project = project;
            this.open = this.loadOpen();
            this.fitPending = true;
        }
        this.steps = steps;
        this.activeId = activeId;
        void this.render();
    }

    public destroy(): void {
        this.graph?.destroy();
        this.graph = null;
    }

    private setOpen(open: Set<string>): void {
        this.open = open;
        this.saveOpen();
        this.fitPending = true;
        void this.render();
    }

    private toggle(id: string): void {
        const next = new Set(this.open);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        this.setOpen(next);
    }

    private async render(): Promise<void> {
        if (this.lib === null) {
            this.note.textContent = t('loading');
            try {
                this.lib = await loadJsNGraph();
            } catch (error) {
                this.note.textContent = t('failed', {message: error instanceof Error ? error.message : String(error)});
                return;
            }
        }
        const lib = this.lib;
        // Ids of phases that no longer exist drop out of the open set.
        const phases = new Set(phaseIds(this.steps));
        const open = new Set([...this.open].filter((id) => phases.has(id)));
        const dag = buildRoadmapDag(this.steps, open);

        this.note.textContent = dag.edges.length === 0 ? t('noDeps') : '';

        const nodes: NGraphNodeData[] = dag.nodes.map((n) => this.toNode(n));
        const edges: NGraphEdgeData[] = dag.edges.map((e) => ({
            id: `${e.source}>${e.target}`,
            source: e.source,
            target: e.target,
            directed: true,
            animated: false,
            width: Math.min(4, 1 + Math.log2(e.count)),
            ...(e.count > 1 ? {label: `×${e.count}`} : {})
        }));
        const hulls: NGraphHull[] = dag.hulls.map((h) => ({id: h.id, nodeIds: h.nodeIds, label: `${h.id} ${h.title}`, padding: 30}));

        const graph = this.ensureGraph(lib);
        graph.setData(nodes, edges);
        graph.setHulls(hulls);
    }

    private toNode(n: DagNode): NGraphNodeData {
        const title = `${n.id} ${n.title}`;
        const color = this.cssVar(STATUS_TOKEN[n.status]);
        return {
            id: n.id,
            label: title.length > LABEL_MAX ? `${title.slice(0, LABEL_MAX - 1)}…` : title,
            sublabel: n.isPhase
                ? `${t('hidden', {count: n.hidden})} · ${n.progress} %`
                : t('progress', {status: this.opts.statusLabel(n.status), progress: n.progress}),
            shape: 'card',
            status: STATUS_DOT[n.status],
            kind: n.isPhase ? 'database' : 'generic',
            ring: n.column,
            pulse: n.id === this.activeId || n.status === 'ai_active',
            meta: {title: n.title},
            ...(color !== null ? {color} : {})
        };
    }

    private ensureGraph(lib: JsNGraph): NGraph {
        if (this.graph !== null) return this.graph;
        const graph = new lib.NGraph(this.stage, {
            theme: readGraphTheme(lib, this.element),
            layoutMode: 'layered',
            // Cards are 46 px high and up to 210 px wide: big phases grow past the canvas, fit() zooms out.
            layeredLayout: {marginX: 140, marginY: 60, maxSpacing: 70, minSpacing: 58, minColumnGap: 250, sweeps: 6, easing: 0.2},
            panZoom: true,
            minZoom: 0.05,
            maxZoom: 2.5,
            detailPanel: false,
            draggable: true,
            grid: false,
            lasso: false,
            tooltip: (node) => `${node.id} ${node.meta?.title ?? node.label}`
        });
        graph.on('nodeClick', (node) => {
            if (node !== null) this.opts.onSelect(node.id);
        });
        graph.on('nodeDblClick', (node) => {
            if (node !== null && phaseIds(this.steps).includes(node.id)) this.toggle(node.id);
        });
        graph.on('nodeHover', (node) => {
            graph.highlight(node === null ? null : graph.neighborhood(node.id, 1));
        });
        graph.on('layoutSettle', () => {
            if (this.fitPending) {
                this.fitPending = false;
                graph.fit({maxScale: 1.4, padding: 40});
            }
        });
        this.graph = graph;
        return graph;
    }

    private cssVar(name: string): string | null {
        const value = getComputedStyle(this.element.isConnected ? this.element : document.documentElement).getPropertyValue(name).trim();
        return value === '' ? null : value;
    }

    private storageKey(): string | null {
        return this.project === null ? null : `synaipse.rm.dagOpen.${this.project}`;
    }

    private loadOpen(): Set<string> {
        const key = this.storageKey();
        try {
            const raw = key === null ? null : readItem(key);
            const parsed: unknown = raw === null ? [] : JSON.parse(raw);
            return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
        } catch {
            return new Set();
        }
    }

    private saveOpen(): void {
        const key = this.storageKey();
        // Private mode: the open phases just are not remembered.
        if (key !== null) writeItem(key, JSON.stringify([...this.open]));
    }

    /** Remove the canvas when the panel switches back to the table. */
    public detach(): void {
        this.destroy();
        clear(this.stage);
    }
}
