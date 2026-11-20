import type {Graph} from '@synaipse/core';
import {describe, expect, it} from 'vitest';
import type {NoteSummary} from '../src/Api.js';
import {paletteCommands, type CommandActions} from '../src/AppCommands.js';
import type {GraphDelta} from '../src/GraphDelta.js';
import {effectiveViewMode, tagEntries, viewModeOverride} from '../src/GraphPrefs.js';
import {TAB_DEFS} from '../src/Tabs.js';
import {VaultStore} from '../src/VaultStore.js';

const note = (id: string): NoteSummary => ({id, title: id.toUpperCase(), tags: []} as unknown as NoteSummary);
const graph = (): Graph => ({
    nodes: [
        {id: 'a', title: 'A', tags: ['x', 'y']},
        {id: 'b', title: 'B', tags: ['y']},
        {id: 'c', title: 'C', tags: ['z']}
    ],
    edges: []
} as unknown as Graph);

const delta = (from: number, to: number, part: Partial<GraphDelta> = {}): GraphDelta => ({
    from,
    to,
    nodes: {upsert: [], removed: []},
    edges: {added: [], removed: []},
    notes: {upsert: [], removed: []},
    ...part
});

const store = async (withGraph: boolean): Promise<VaultStore> => {
    const s = new VaultStore({
        listNotes: async () => ({data: [note('a'), note('b')], version: 3}),
        getGraph: async () => ({data: graph(), version: 3})
    });
    await s.loadNotes();
    if (withGraph) await s.loadGraph();
    return s;
};

describe('VaultStore (plan P7 / D2)', () => {
    it('applies an in-order delta to notes; the graph stays untouched until loaded', async () => {
        const s = await store(false);
        const out = s.applyDelta(delta(3, 4, {notes: {upsert: [note('c')], removed: ['a']}}));
        expect(out).toEqual({notesChanged: true, graphChanged: false, reload: false});
        expect(s.notes.map((n) => n.id).sort()).toEqual(['b', 'c']);
        expect(s.graph).toBeNull();
    });

    it('a version gap asks for a reload and leaves the notes alone', async () => {
        const s = await store(true);
        expect(s.applyDelta(delta(7, 8, {notes: {upsert: [note('c')], removed: []}})).reload).toBe(true);
        expect(s.notes).toHaveLength(2);
    });

    it('an empty graph delta only advances the version; a real one changes the graph', async () => {
        const s = await store(true);
        expect(s.applyDelta(delta(3, 4))).toEqual({notesChanged: false, graphChanged: false, reload: false});
        const out = s.applyDelta(delta(4, 5, {nodes: {upsert: [], removed: ['c']}}));
        expect(out.graphChanged).toBe(true);
        expect(s.graph!.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    });

    it('a graph fetched at another version than the notes triggers a reload', async () => {
        const s = new VaultStore({
            listNotes: async () => ({data: [], version: 3}),
            getGraph: async () => ({data: graph(), version: 2})
        });
        await s.loadNotes();
        await s.loadGraph();
        expect(s.applyDelta(delta(3, 4))).toEqual({notesChanged: false, graphChanged: false, reload: true});
    });

    it('dropGraph forgets graph and version', async () => {
        const s = await store(true);
        s.dropGraph();
        expect(s.graph).toBeNull();
        expect(s.applyDelta(delta(3, 4)).reload).toBe(false);
    });
});

describe('GraphPrefs rules', () => {
    it('forces 2D from 20k nodes and warns about 3D from 5k', () => {
        expect(effectiveViewMode('3d', 19_999)).toBe('3d');
        expect(effectiveViewMode('3d', 20_000)).toBe('2d');
        expect(effectiveViewMode('2d', 50_000)).toBe('2d');
        expect(viewModeOverride('2d', 4_999)).toBeNull();
        expect(viewModeOverride('2d', 6_000)).toBeNull();
        expect(viewModeOverride('3d', 6_000)).toEqual({kind: 'warned', nodeCount: 6_000});
        expect(viewModeOverride('2d', 20_000)).toEqual({kind: 'forced', nodeCount: 20_000});
    });

    it('tag entries count nodes, most used first, ties alphabetical', () => {
        expect(tagEntries(graph())).toEqual([
            {tag: 'y', count: 2},
            {tag: 'x', count: 1},
            {tag: 'z', count: 1}
        ]);
    });
});

describe('AppCommands', () => {
    const noop = (): void => undefined;
    const actions = (extra: Partial<CommandActions> = {}): CommandActions => ({
        goTab: noop, isLightTheme: false, is3d: false, newNote: noop, focusSearch: noop, openImport: noop,
        toggleTheme: noop, toggleActivity: noop, toggleGraphMode: noop, newRoadmapProject: noop, newRoadmapStep: noop,
        ...extra
    });

    it('offers every tab plus the fixed commands; link and settings only when available', () => {
        const ids = paletteCommands(actions()).map((c) => c.id);
        expect(ids.filter((id) => id.startsWith('tab:'))).toHaveLength(TAB_DEFS.length);
        expect(ids).toContain('graph:mode');
        expect(ids).not.toContain('link');
        expect(ids).not.toContain('settings');

        const full = paletteCommands(actions({copyLink: noop, openSettings: noop})).map((c) => c.id);
        expect(full).toContain('link');
        expect(full).toContain('settings');
    });

    it('labels follow the current theme and graph mode', () => {
        const label = (a: CommandActions, id: string): string | undefined => paletteCommands(a).find((c) => c.id === id)?.label;
        expect(label(actions({is3d: true}), 'graph:mode')).toBe('Graph: switch to 2D');
        expect(label(actions({isLightTheme: true}), 'theme')).toBe('Switch to dark theme');
    });
});
