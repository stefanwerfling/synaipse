import {describe, it, expect} from 'vitest';
import {emptyCanvas, parseCanvas, serializeCanvas} from '../src/Index.js';

describe('parseCanvas', () => {
    it('returns empty on blank input', () => {
        expect(parseCanvas('')).toEqual(emptyCanvas());
        expect(parseCanvas('   \n  ')).toEqual(emptyCanvas());
    });

    it('returns empty on malformed JSON without throwing', () => {
        expect(parseCanvas('{not json')).toEqual(emptyCanvas());
    });

    it('parses a canonical Obsidian text node', () => {
        const raw = JSON.stringify({
            nodes: [{id: 'a', type: 'text', x: 10, y: 20, width: 200, height: 100, text: 'hello'}],
            edges: []
        });
        expect(parseCanvas(raw).nodes).toEqual([
            {id: 'a', type: 'text', x: 10, y: 20, width: 200, height: 100, text: 'hello'}
        ]);
    });

    it('parses all four node types', () => {
        const raw = JSON.stringify({
            nodes: [
                {id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hi'},
                {id: 'b', type: 'file', x: 200, y: 0, width: 100, height: 50, file: 'Memory/foo.md'},
                {id: 'c', type: 'link', x: 400, y: 0, width: 100, height: 50, url: 'https://example.com'},
                {id: 'd', type: 'group', x: 0, y: 200, width: 500, height: 300, label: 'Cluster'}
            ],
            edges: []
        });
        const parsed = parseCanvas(raw);
        expect(parsed.nodes.map((n) => n.type)).toEqual(['text', 'file', 'link', 'group']);
    });

    it('drops nodes missing required fields', () => {
        const raw = JSON.stringify({
            nodes: [
                {id: 'ok', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'yes'},
                {id: 'missing-text', type: 'text', x: 0, y: 0, width: 10, height: 10},
                {type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'no-id'},
                {id: 'bad-coord', type: 'text', x: 'left', y: 0, width: 10, height: 10, text: 'x'},
                {id: 'unknown', type: 'sticker', x: 0, y: 0, width: 10, height: 10}
            ]
        });
        expect(parseCanvas(raw).nodes.map((n) => n.id)).toEqual(['ok']);
    });

    it('drops dangling edges (referencing missing nodes)', () => {
        const raw = JSON.stringify({
            nodes: [
                {id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'a'},
                {id: 'b', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'b'}
            ],
            edges: [
                {id: 'e1', fromNode: 'a', toNode: 'b'},
                {id: 'e2', fromNode: 'a', toNode: 'missing'},
                {id: 'e3', fromNode: 'ghost', toNode: 'b'}
            ]
        });
        expect(parseCanvas(raw).edges.map((e) => e.id)).toEqual(['e1']);
    });

    it('preserves optional edge sides and labels', () => {
        const raw = JSON.stringify({
            nodes: [
                {id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'a'},
                {id: 'b', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'b'}
            ],
            edges: [
                {id: 'e', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left', label: 'flows into'}
            ]
        });
        expect(parseCanvas(raw).edges[0]).toEqual({
            id: 'e',
            fromNode: 'a',
            toNode: 'b',
            fromSide: 'right',
            toSide: 'left',
            label: 'flows into'
        });
    });

    it('rejects invalid side values instead of coercing', () => {
        const raw = JSON.stringify({
            nodes: [
                {id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'a'},
                {id: 'b', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'b'}
            ],
            edges: [
                {id: 'e', fromNode: 'a', fromSide: 'upper-left', toNode: 'b'}
            ]
        });
        expect(parseCanvas(raw).edges[0]?.fromSide).toBeUndefined();
    });
});

describe('serializeCanvas', () => {
    it('round-trips through parseCanvas', () => {
        const doc = {
            nodes: [
                {id: 'a', type: 'text' as const, x: 0, y: 0, width: 200, height: 100, text: 'hello'}
            ],
            edges: []
        };
        expect(parseCanvas(serializeCanvas(doc))).toEqual(doc);
    });
});