import {afterEach, describe, expect, it, vi} from 'vitest';
import type {Graph, Note} from '@synaipse/core';
import type {SynaipseService} from '@synaipse/service';
import {GraphDeltaPublisher, type GraphDelta} from '../server/graph-deltas.js';
import {applyGraphDelta, applyNotesDelta, isEmptyGraphDelta, parseVersion} from '../../web-client/src/GraphDelta.js'; // round trip: server publisher → client applier

interface FakeNote {
    id: string;
    title: string;
    tags: string[];
    links: string[];
    body: string;
}

/** Minimal service: notes in a map, graph derived from links, version bumped per change. */
class FakeService {
    public notes = new Map<string, FakeNote>();
    public version = 0;
    private listener: ((v: number) => void) | null = null;

    public set(note: FakeNote): void {
        this.notes.set(note.id, note);
        this.bump();
    }

    public remove(id: string): void {
        this.notes.delete(id);
        this.bump();
    }

    public bump(): void {
        this.version++;
        this.listener?.(this.version);
    }

    public graphVersion(): number {
        return this.version;
    }

    public graph(): Graph {
        const all = [...this.notes.values()];
        return {
            nodes: all.map((n) => ({id: n.id, title: n.title, tags: n.tags})),
            edges: all.flatMap((n) => n.links.filter((l) => this.notes.has(l)).map((to) => ({from: n.id, to, kind: 'wikilink' as const})))
        };
    }

    public listNotes(): Note[] {
        // Fresh copies on every call, like Vault.list().
        return [...this.notes.values()].map((n) => ({
            id: n.id, title: n.title, tags: n.tags, frontmatter: {}, mtime: 1, hash: `${n.title}|${n.body}|${n.tags.join(',')}`
        }) as unknown as Note);
    }

    public noteFlags(): {private: boolean} {
        return {private: false};
    }

    public onTopologyChange(listener: (v: number) => void): () => void {
        this.listener = listener;
        return () => {
            this.listener = null;
        };
    }
}

const sink = (clients = 1) => {
    const sent: Array<{name: string; data: unknown}> = [];
    return {
        sent,
        clients,
        clientCount() {
            return this.clients;
        },
        publishNamed(name: string, data: unknown) {
            sent.push({name, data});
        }
    };
};

const note = (id: string, links: string[] = [], extra: Partial<FakeNote> = {}): FakeNote =>
    ({id, title: id.toUpperCase(), tags: [], links, body: '', ...extra});

const summaries = (svc: FakeService) => svc.listNotes().map((n) => ({id: n.id, title: n.title, tags: n.tags, mtime: 1, aliases: []}));

const sortGraph = (g: Graph): Graph => ({
    nodes: [...g.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...g.edges].sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`))
});

afterEach(() => {
    vi.useRealTimers();
});

describe('GraphDeltaPublisher', () => {
    it('diffs nodes, edges and notes; the client applies it to the exact new state', () => {
        const svc = new FakeService();
        svc.set(note('a', ['b']));
        svc.set(note('b'));
        svc.set(note('c', ['a']));
        const out = sink();
        const pub = new GraphDeltaPublisher(svc as unknown as SynaipseService, out);
        pub.prime();

        const beforeGraph = svc.graph();
        const beforeNotes = summaries(svc);
        const from = svc.version;

        svc.set(note('a', ['c'], {title: 'Alpha'}));   // retitled, link b → c
        svc.remove('b');                                // node + note gone
        svc.set(note('d', ['a']));                      // new node + edge
        svc.set(note('c', ['a'], {body: 'edited'}));   // content only: note upsert, no graph change

        const sent = pub.flush();
        const delta = sent?.delta as GraphDelta;
        expect(delta.from).toBe(from);
        expect(delta.to).toBe(svc.version);
        expect(delta.nodes.upsert.map((n) => n.id).sort()).toEqual(['a', 'd']);
        expect(delta.nodes.removed).toEqual(['b']);
        expect(delta.edges.removed).toEqual([{from: 'a', to: 'b', kind: 'wikilink'}]);
        expect(delta.notes.upsert.map((n) => n.id).sort()).toEqual(['a', 'c', 'd']);
        expect(delta.notes.removed).toEqual(['b']);
        expect(out.sent).toEqual([{name: 'graph-delta', data: delta}]);

        expect(sortGraph(applyGraphDelta(beforeGraph, delta))).toEqual(sortGraph(svc.graph()));
        expect(applyNotesDelta(beforeNotes, delta).map((n) => n.id).sort()).toEqual(['a', 'c', 'd']);
        pub.close();
    });

    it('sends a content-only change as a delta with an empty graph part', () => {
        const svc = new FakeService();
        svc.set(note('a'));
        const out = sink();
        const pub = new GraphDeltaPublisher(svc as unknown as SynaipseService, out);
        pub.prime();

        svc.set(note('a', [], {body: 'new text'}));
        const delta = pub.flush()?.delta as GraphDelta;
        expect(isEmptyGraphDelta(delta)).toBe(true);
        expect(delta.notes.upsert).toHaveLength(1);
        expect(pub.flush()).toBeNull();
        pub.close();
    });

    it('does no work without clients and resets when there is no baseline', () => {
        const svc = new FakeService();
        const out = sink(0);
        const pub = new GraphDeltaPublisher(svc as unknown as SynaipseService, out);
        const graphSpy = vi.spyOn(svc, 'graph');

        svc.set(note('a'));
        expect(pub.flush()).toBeNull();
        expect(graphSpy).not.toHaveBeenCalled();

        out.clients = 1;
        svc.set(note('b'));
        expect(pub.flush()).toEqual({reset: {to: svc.version}});
        expect(out.sent[0]?.name).toBe('graph-reset');
        pub.close();
    });

    it('turns oversized deltas into a reset', () => {
        const svc = new FakeService();
        const out = sink();
        const pub = new GraphDeltaPublisher(svc as unknown as SynaipseService, out, {maxChanges: 3});
        pub.prime();

        for (let i = 0; i < 5; i++) svc.set(note(`n${i}`));
        expect(pub.flush()).toEqual({reset: {to: svc.version}});
        pub.close();
    });

    it('debounces bursts but flushes within maxWait', () => {
        vi.useFakeTimers();
        const svc = new FakeService();
        const out = sink();
        const pub = new GraphDeltaPublisher(svc as unknown as SynaipseService, out, {debounceMs: 100, maxWaitMs: 300});
        pub.prime();

        for (let i = 0; i < 10; i++) {
            svc.set(note(`n${i}`));
            vi.advanceTimersByTime(50);
        }

        // 500 ms of writes every 50 ms: debounce alone would never fire.
        expect(out.sent.length).toBeGreaterThanOrEqual(1);
        vi.advanceTimersByTime(200);
        const deltas = out.sent.map((s) => s.data as GraphDelta);
        expect(deltas[deltas.length - 1]?.to).toBe(svc.version);
        // Consecutive deltas chain without gaps.
        for (let i = 1; i < deltas.length; i++) {
            expect(deltas[i]?.from).toBe(deltas[i - 1]?.to);
        }
        pub.close();
    });
});

describe('client delta helpers', () => {
    it('applies idempotently and drops edges of removed nodes', () => {
        const graph: Graph = {
            nodes: [{id: 'a', title: 'A', tags: []}, {id: 'b', title: 'B', tags: []}],
            edges: [{from: 'a', to: 'b', kind: 'wikilink'}, {from: 'b', to: 'a', kind: 'wikilink'}]
        };
        const delta: GraphDelta = {
            from: 1, to: 2,
            nodes: {upsert: [{id: 'c', title: 'C', tags: []}], removed: ['b']},
            edges: {added: [{from: 'c', to: 'a', kind: 'wikilink'}, {from: 'c', to: 'a', kind: 'wikilink'}], removed: []},
            notes: {upsert: [], removed: []}
        };

        const next = applyGraphDelta(graph, delta);
        expect(next.nodes.map((n) => n.id)).toEqual(['a', 'c']);
        expect(next.edges).toEqual([{from: 'c', to: 'a', kind: 'wikilink'}]);
        expect(graph.nodes).toHaveLength(2);
    });

    it('parses the version header', () => {
        expect(parseVersion('42')).toBe(42);
        expect(parseVersion(null)).toBeNull();
        expect(parseVersion('x')).toBeNull();
    });
});
