import type {NGraph, NGraphEdgeData, NGraphNodeData, ThemeTokens} from 'jsngraph';
import {api, type LocalGraphData} from './Api.js';
import {el} from './Dom.js';
import {edgeKinds, loadJsNGraph, readGraphTheme, TYPED_LABEL, type JsNGraph} from './GraphStyle.js';
import {PersistentValue} from './Persistence.js';
import {onThemeChange} from './Theme.js';

interface LocalGraphPrefs {
    open: boolean;
    depth: 1 | 2;
}

const PREFS_KEY = 'synaipse-local-graph';
const NODE_LIMIT = 60;

/**
 * Local graph of the open note (plan P5 / S1): the note's ego network
 * (1 or 2 hops, wikilinks both ways plus typed frontmatter links) drawn
 * with jsNGraph's radial layout — the note in the middle, direct links on
 * the first ring, second-hop notes on the outer ring.
 *
 * The element survives viewer re-renders (NotesPanel re-appends it), so
 * re-rendering the same note does not reset the picture. The NGraph is
 * created on first expand and pauses by itself while detached or hidden.
 */
export class LocalGraphPanel {

    public readonly element: HTMLElement;

    private readonly body: HTMLElement;
    private readonly stage: HTMLElement;
    private readonly status: HTMLElement;
    private readonly toggleBtn: HTMLButtonElement;
    private readonly depthBtns: Map<1 | 2, HTMLButtonElement> = new Map();
    private readonly prefs = new PersistentValue<LocalGraphPrefs>(PREFS_KEY, {open: true, depth: 1});
    private readonly unsubscribeTheme: () => void;

    private graph: NGraph | null = null;
    private lib: JsNGraph | null = null;
    private noteId: string | null = null;
    private loadedKey: string | null = null;
    private loadSeq = 0;
    private fitPending = false;

    public constructor(private readonly onOpenNote: (id: string) => void) {
        this.toggleBtn = el('button', {
            class: 'local-graph-toggle',
            attrs: {type: 'button', 'aria-expanded': 'true'},
            on: {click: () => this.setOpen(!this.prefs.get().open)}
        },
            el('span', {class: 'local-graph-chevron', attrs: {'aria-hidden': 'true'}, text: '▾'}),
            el('span', {text: 'Local graph'})
        ) as HTMLButtonElement;

        const depthGroup = el('div', {class: 'local-graph-depth', attrs: {role: 'group', 'aria-label': 'Link depth'}});

        for (const depth of [1, 2] as const) {
            const btn = el('button', {
                class: 'local-graph-depth-btn',
                attrs: {type: 'button', title: depth === 1 ? 'Direct links' : 'Links of links'},
                text: depth === 1 ? '1 hop' : '2 hops',
                on: {click: () => this.setDepth(depth)}
            }) as HTMLButtonElement;
            this.depthBtns.set(depth, btn);
            depthGroup.appendChild(btn);
        }

        const fitBtn = el('button', {
            class: 'local-graph-fit',
            attrs: {type: 'button', title: 'Fit to view'},
            text: 'Fit',
            on: {click: () => this.graph?.fit({animate: true, maxScale: 1.2})}
        });

        this.status = el('span', {class: 'local-graph-status'});
        this.stage = el('div', {class: 'local-graph-stage'});
        this.body = el('div', {class: 'local-graph-body'}, this.stage);
        this.element = el('div', {class: 'viewer-links-block local-graph'},
            el('div', {class: 'local-graph-head'}, this.toggleBtn, this.status, depthGroup, fitBtn),
            this.body
        );

        this.unsubscribeTheme = onThemeChange(() => {
            // CSS variables switch with the root's data-theme; read them after it applied.
            requestAnimationFrame(() => {
                if (this.graph !== null && this.lib !== null) this.graph.setTheme(this.readTheme(this.lib));
            });
        });

        this.syncControls();
    }

    /** Show the local graph of `id` (null = nothing open). Same note + depth → no refetch. */
    public setNote(id: string | null): void {
        this.noteId = id;

        if (this.prefs.get().open) {
            void this.load();
        }
    }

    /** Force a refetch (the vault changed). */
    public refresh(): void {
        this.loadedKey = null;

        if (this.prefs.get().open) {
            void this.load();
        }
    }

    public destroy(): void {
        this.loadSeq++;
        this.unsubscribeTheme();
        this.graph?.destroy();
        this.graph = null;
        this.prefs.destroy();
        this.element.remove();
    }

    private setOpen(open: boolean): void {
        this.prefs.set({...this.prefs.get(), open});
        this.syncControls();

        if (open) {
            void this.load();
        }
    }

    private setDepth(depth: 1 | 2): void {
        if (this.prefs.get().depth === depth) return;
        this.prefs.set({...this.prefs.get(), depth});
        this.syncControls();
        void this.load();
    }

    private syncControls(): void {
        const {open, depth} = this.prefs.get();

        this.element.classList.toggle('is-collapsed', !open);
        this.toggleBtn.setAttribute('aria-expanded', String(open));
        this.body.hidden = !open;

        for (const [d, btn] of this.depthBtns) {
            btn.classList.toggle('is-active', d === depth);
            btn.setAttribute('aria-pressed', String(d === depth));
        }
    }

    private async load(): Promise<void> {
        const id = this.noteId;
        const depth = this.prefs.get().depth;

        if (id === null) return;

        const key = `${id}\u0000${depth}`;
        if (key === this.loadedKey) return;

        const seq = ++this.loadSeq;
        this.status.textContent = 'loading…';

        let data: LocalGraphData;
        try {
            [data, this.lib] = await Promise.all([api.getLocalGraph(id, depth, NODE_LIMIT), loadJsNGraph()]);
        } catch (error) {
            if (seq !== this.loadSeq) return;
            this.status.textContent = 'unavailable';
            this.status.title = error instanceof Error ? error.message : String(error);
            return;
        }

        if (seq !== this.loadSeq) return;

        this.loadedKey = key;
        this.render(data, this.lib);
    }

    private ensureGraph(lib: JsNGraph): NGraph {
        if (this.graph !== null) return this.graph;

        this.graph = new lib.NGraph(this.stage, {
            theme: this.readTheme(lib),
            layoutMode: 'radial',
            radialLayout: {margin: 34, minArc: 30, hubRadius: 0, easing: 0.18},
            panZoom: true,
            minZoom: 0.25,
            maxZoom: 3,
            detailPanel: false,
            draggable: true,
            grid: false,
            lasso: false,
            labelMinZoom: 0.6,
            edgeKinds: edgeKinds(lib),
            tooltip: (node) => node.meta?.path ?? node.label
        });

        this.graph.on('nodeClick', (node) => {
            if (node !== null && node.id !== this.noteId) this.onOpenNote(node.id);
        });
        this.graph.on('nodeHover', (node) => {
            this.graph?.highlight(node === null ? null : this.graph.neighborhood(node.id, 1));
        });
        this.graph.on('layoutSettle', () => {
            if (this.fitPending) {
                this.fitPending = false;
                this.graph?.fit({maxScale: 1.2, padding: 24});
            }
        });

        return this.graph;
    }

    private render(data: LocalGraphData, lib: JsNGraph): void {
        const others = data.nodes.length - 1;

        this.status.textContent = others === 0
            ? 'no linked notes'
            : `${others} note${others === 1 ? '' : 's'}${data.truncated ? ' (top ' + NODE_LIMIT + ')' : ''}`;
        this.status.title = '';

        const maxDegree = Math.max(1, ...data.nodes.map((n) => n.degree));
        const accent = LocalGraphPanel.cssVar(this.element, '--accent');
        const nodes: NGraphNodeData[] = LocalGraphPanel.ringOrder(data).map((n) => {
            const center = n.id === data.center;
            const node: NGraphNodeData = {
                id: n.id,
                label: LocalGraphPanel.shorten(n.title),
                shape: 'dot',
                ring: n.hop,
                group: LocalGraphPanel.folderOf(n.id),
                // sqrt scale: a hub stands out without dwarfing the rest
                size: center ? 12 : 5 + Math.round(5 * Math.sqrt(n.degree / maxDegree)),
                meta: {path: n.id}
            };

            if (center && accent !== null) node.color = accent;
            return node;
        });
        const edges: NGraphEdgeData[] = data.edges.map((e, i) => {
            const edge: NGraphEdgeData = {id: `${i}:${e.from}>${e.to}:${e.kind}`, source: e.from, target: e.to, kind: e.kind};
            const label = TYPED_LABEL[e.kind];

            if (label !== undefined) edge.label = label;
            return edge;
        });

        const graph = this.ensureGraph(lib);

        graph.clearHighlight();
        graph.setViewport({scale: 1, offsetX: 0, offsetY: 0});
        graph.setData(nodes, edges);
        graph.select([data.center]);
        this.fitPending = true;
    }

    private readTheme(lib: JsNGraph): ThemeTokens {
        return readGraphTheme(lib, this.element);
    }

    /**
     * The radial layout places each ring in input order, clockwise from
     * 12 o'clock. Sorting every outer-ring note by the slot of its first
     * neighbour on the ring inside keeps children next to their parent
     * instead of across the circle (fewer crossings).
     */
    private static ringOrder(data: LocalGraphData): LocalGraphData['nodes'] {
        const neighbours = new Map<string, Set<string>>();
        const link = (a: string, b: string): void => {
            let set = neighbours.get(a);
            if (set === undefined) neighbours.set(a, set = new Set());
            set.add(b);
        };

        for (const e of data.edges) {
            link(e.from, e.to);
            link(e.to, e.from);
        }

        // Slot position as a fraction of a full turn, clockwise from 12 o'clock.
        // jsNGraph's RadialLayout staggers even rings by half a slot.
        const turn = new Map<string, number>();
        const ordered: LocalGraphData['nodes'] = [];
        const maxHop = Math.max(0, ...data.nodes.map((n) => n.hop));
        const hopOf = new Map(data.nodes.map((n) => [n.id, n.hop]));
        const slotTurn = (hop: number, index: number, count: number): number =>
            ((index + (hop % 2 === 0 ? 0.5 : 0)) / Math.max(1, count)) % 1;
        const circular = (a: number, b: number): number => {
            const d = Math.abs(a - b) % 1;
            return Math.min(d, 1 - d);
        };

        for (let hop = 0; hop <= maxHop; hop++) {
            let ring = data.nodes.filter((n) => n.hop === hop);

            if (hop >= 2 && ring.length > 1) {
                const anchorOf = (id: string): number | null => {
                    let best: number | null = null;
                    for (const other of neighbours.get(id) ?? []) {
                        const t = turn.get(other);
                        if (t !== undefined && hopOf.get(other) === hop - 1 && (best === null || t < best)) best = t;
                    }
                    return best;
                };
                const anchors = new Map(ring.map((n) => [n.id, anchorOf(n.id)]));
                const sorted = ring
                    .map((n, i) => ({n, i, a: anchors.get(n.id) ?? 2}))
                    .sort((x, y) => x.a - y.a || x.i - y.i)
                    .map((x) => x.n);

                // Pick the rotation that puts children closest to their parents' angles.
                let bestShift = 0;
                let bestCost = Infinity;
                for (let shift = 0; shift < sorted.length; shift++) {
                    let cost = 0;
                    sorted.forEach((n, k) => {
                        const a = anchors.get(n.id);
                        if (a !== null && a !== undefined) cost += circular(slotTurn(hop, (k + shift) % sorted.length, sorted.length), a);
                    });
                    if (cost < bestCost - 1e-9) {
                        bestCost = cost;
                        bestShift = shift;
                    }
                }

                ring = new Array<LocalGraphData['nodes'][number]>(sorted.length);
                sorted.forEach((n, k) => {
                    ring[(k + bestShift) % sorted.length] = n;
                });
            }

            ring.forEach((n, i) => {
                turn.set(n.id, slotTurn(hop, i, ring.length));
                ordered.push(n);
            });
        }

        return ordered;
    }

    private static cssVar(scope: Element, name: string): string | null {
        if (!scope.isConnected) return null;
        const value = getComputedStyle(scope).getPropertyValue(name).trim();
        return value.length > 0 ? value : null;
    }

    private static folderOf(id: string): string {
        const slash = id.indexOf('/');
        return slash > 0 ? id.slice(0, slash) : '(root)';
    }

    private static shorten(title: string): string {
        return title.length > 28 ? title.slice(0, 27) + '…' : title;
    }

}
