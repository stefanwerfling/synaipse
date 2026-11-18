import type {EdgeKindStyle, ThemeTokens} from 'jsngraph';
import {getTheme} from './Theme.js';

export type JsNGraph = typeof import('jsngraph');

let jsngraphModule: Promise<JsNGraph> | null = null;

/** jsNGraph is loaded on first use, so it stays out of the initial bundle (plan D4). */
export const loadJsNGraph = (): Promise<JsNGraph> => jsngraphModule ??= import('jsngraph');

/**
 * Typed frontmatter links as edge kinds: all directed, in the neutral tone,
 * labelled so the relation is readable when zoomed in. `supersedes` keeps
 * its dashed preset look.
 */
export const edgeKinds = (lib: JsNGraph): Record<string, EdgeKindStyle> => ({
    ...lib.EdgeKindPresets.knowledge,
    duplicates: {tone: 'neutral', directed: true, dashed: [3, 3], animated: false},
    relates_to: {tone: 'neutral', directed: true, animated: false},
    replies_to: {tone: 'neutral', directed: true, animated: false}
});

export const TYPED_LABEL: Record<string, string> = {
    supersedes: 'supersedes',
    duplicates: 'duplicates',
    relates_to: 'relates to',
    replies_to: 'replies to'
};

/**
 * Graph tokens from the Synaipse design tokens, so every jsNGraph view
 * matches the app in both themes (plan E3 / J10).
 */
export const readGraphTheme = (lib: JsNGraph, element: HTMLElement): ThemeTokens => lib.Theme.fromCssVars(
    element.isConnected ? element : document.documentElement,
    {
        base: getTheme() === 'light' ? lib.Theme.light : lib.Theme.dark,
        map: {
            background: '--bg-1',
            gridDot: '--border-soft',
            nodeFill: '--bg-2',
            nodeStroke: '--border-strong',
            nodeIcon: '--text-1',
            nodeLabel: '--text-2',
            nodeHoverStroke: '--accent-hover',
            nodeSelectedStroke: '--accent',
            edgeNeutral: '--border-strong',
            edgeLabel: '--text-3',
            highlightStroke: '--gold',
            panelBackground: '--bg-2',
            panelBorder: '--border',
            panelText: '--text-0',
            panelSubtext: '--text-2'
        }
    }
);
