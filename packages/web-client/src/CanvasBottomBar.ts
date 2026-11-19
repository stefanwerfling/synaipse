import type {CanvasDocument, CanvasNode} from '@synaipse/core';
import {clear, el} from './Dom.js';
import {arrowStyleOf, COLOR_PRESET_ORDER, COLOR_PRESETS, type ArrowStyle} from './CanvasGeometry.js';

/**
 * Contextual bottom bar of the canvas (plan P7 / D2): actions for
 * whatever is selected, in a fixed spot at the bottom of the viewport —
 * OneNote-ish — so users don't chase a floating panel around. Empty
 * selection hides the bar.
 */

export interface BottomBarActions {
    setNodesColor: (ids: string[], preset: string | undefined) => void;
    setEdgeColor: (edgeId: string, preset: string | undefined) => void;
    setEdgeArrow: (edgeId: string, style: ArrowStyle) => void;
    removeNodes: (ids: string[]) => void;
    removeEdge: (edgeId: string) => void;
    editText: (nodeId: string) => void;
    openNote: (fileId: string) => void;
}

export interface BottomBarSelection {
    edgeId: string | null;
    nodeIds: readonly string[];
}

/** Button whose click never reaches the canvas pointer handlers. */
const barButton = (cls: string, title: string, ariaLabel: string, onClick: () => void, text?: string): HTMLElement => el('button', {
    class: cls,
    attrs: {type: 'button', title, 'aria-label': ariaLabel},
    ...(text !== undefined ? {text} : {}),
    on: {click: (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onClick();
    }}
});

const kind = (text: string): HTMLElement => el('span', {class: 'canvas-bottom-bar-kind', text});
const sep = (): HTMLElement => el('div', {class: 'canvas-bottom-bar-sep'});

const colorSwatches = (current: string | undefined, onPick: (preset: string | undefined) => void): HTMLElement => {
    const wrap = el('div', {class: 'canvas-bottom-bar-swatches'});

    for (const preset of COLOR_PRESET_ORDER) {
        const swatch = barButton(
            current === preset ? 'canvas-bottom-bar-swatch active' : 'canvas-bottom-bar-swatch',
            `Color ${preset}`,
            `Color ${preset}`,
            () => onPick(preset)
        );
        swatch.style.background = COLOR_PRESETS[preset] ?? '#888';
        wrap.appendChild(swatch);
    }

    wrap.appendChild(barButton(
        current === undefined
            ? 'canvas-bottom-bar-swatch canvas-bottom-bar-swatch-clear active'
            : 'canvas-bottom-bar-swatch canvas-bottom-bar-swatch-clear',
        'No color',
        'No color',
        () => onPick(undefined)
    ));
    return wrap;
};

const deleteButton = (onDelete: () => void): HTMLElement[] => [
    sep(),
    barButton('canvas-bottom-bar-btn canvas-bottom-bar-btn-danger', 'Delete (Del)', 'Delete', onDelete, '🗑')
];

const multiControls = (doc: CanvasDocument, ids: string[], actions: BottomBarActions): HTMLElement[] => {
    // Reflect the current colour only if every selected node agrees — a
    // mixed selection shows all-inactive so no swatch pretends to
    // represent the group. Clicking still applies to every node.
    const colors = ids.map((id) => doc.nodes.find((n) => n.id === id)?.color);
    const uniform = colors.every((c) => c === colors[0]);
    return [
        kind(`${ids.length} selected`),
        colorSwatches(uniform ? colors[0] : undefined, (preset) => actions.setNodesColor(ids, preset)),
        ...deleteButton(() => actions.removeNodes(ids))
    ];
};

const edgeControls = (edge: CanvasDocument['edges'][number], actions: BottomBarActions): HTMLElement[] => {
    const currentStyle = arrowStyleOf(edge);
    const arrowBtn = (style: ArrowStyle, label: string, title: string): HTMLElement => barButton(
        currentStyle === style ? 'canvas-bottom-bar-btn active' : 'canvas-bottom-bar-btn',
        title,
        title,
        () => actions.setEdgeArrow(edge.id, style),
        label
    );
    return [
        kind('Edge'),
        colorSwatches(edge.color, (preset) => actions.setEdgeColor(edge.id, preset)),
        sep(),
        arrowBtn('to', '→', 'Arrow at target only'),
        arrowBtn('both', '↔', 'Arrows at both ends'),
        arrowBtn('none', '—', 'No arrows'),
        ...deleteButton(() => actions.removeEdge(edge.id))
    ];
};

const nodeControls = (node: CanvasNode, actions: BottomBarActions): HTMLElement[] => {
    const label = node.type === 'group' ? 'Group'
        : node.type === 'text' ? 'Text card'
        : node.type === 'file' ? 'Note card'
        : 'Link card';
    const out = [kind(label)];

    // Text cards edit inline (dblclick works too, but a bar action is
    // more discoverable). File/link cards have their own semantics.
    if (node.type === 'text') {
        out.push(barButton('canvas-bottom-bar-btn', 'Edit text (dblclick)', 'Edit text', () => actions.editText(node.id), '✎ Edit'), sep());
    }
    if (node.type === 'file') {
        const fileId = node.file;
        out.push(barButton('canvas-bottom-bar-btn', 'Open note (dblclick)', 'Open note', () => actions.openNote(fileId), '↗ Open'), sep());
    }

    out.push(
        colorSwatches(node.color, (preset) => actions.setNodesColor([node.id], preset)),
        ...deleteButton(() => actions.removeNodes([node.id]))
    );
    return out;
};

/** Rebuild the bar for the current selection; an edge selection wins over nodes. */
export const renderBottomBar = (
    bar: HTMLElement,
    doc: CanvasDocument,
    selection: BottomBarSelection,
    actions: BottomBarActions
): void => {
    clear(bar);

    let controls: HTMLElement[] | null = null;
    const edge = selection.edgeId === null ? undefined : doc.edges.find((e) => e.id === selection.edgeId);
    if (edge !== undefined) {
        controls = edgeControls(edge, actions);
    } else if (selection.nodeIds.length > 1) {
        controls = multiControls(doc, [...selection.nodeIds], actions);
    } else if (selection.nodeIds.length === 1) {
        const node = doc.nodes.find((n) => n.id === selection.nodeIds[0]);
        if (node !== undefined) controls = nodeControls(node, actions);
    }

    if (controls === null) {
        bar.setAttribute('hidden', 'hidden');
        return;
    }
    for (const c of controls) bar.appendChild(c);
    bar.removeAttribute('hidden');
};
