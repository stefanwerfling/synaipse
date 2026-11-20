/**
 * Infographic-Light (plan P10 / S7): simple `::: infographic chart-…` blocks
 * (columns, bars, lines) are drawn with jsNGraph RectCharts instead of
 * loading @antv/infographic (~800 KB). This module is the pure part: which
 * layouts qualify and a parser for the antv `data` block. Anything it
 * cannot read returns null, and the block falls back to antv.
 */

export type LightChartKind = 'column' | 'bar' | 'line';

export interface LightChartItem {
    label: string;
    value: number;
    desc?: string;
}

export interface LightChartData {
    title?: string;
    desc?: string;
    xTitle?: string;
    yTitle?: string;
    items: LightChartItem[];
}

/** antv chart layouts that RectCharts can draw; pies and word clouds stay antv. */
const LIGHT_LAYOUTS: Record<string, LightChartKind> = {
    'chart-column': 'column',
    'chart-column-simple': 'column',
    'chart-bar': 'bar',
    'chart-bar-plain-text': 'bar',
    'chart-line': 'line',
    'chart-line-plain-text': 'line'
};

export const lightChartKind = (layout: string): LightChartKind | null => LIGHT_LAYOUTS[layout] ?? null;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** `key rest of line` → [key, rest]. */
const splitKey = (text: string): [string, string] => {
    const match = /^(\S+)\s*(.*)$/.exec(text.trim());
    return match === null ? ['', ''] : [match[1] as string, (match[2] as string).trim()];
};

const parseNumber = (raw: string): number | null => {
    const cleaned = raw.replace(/[\s_]/g, '').replace(/,(?=\d{3}(\D|$))/g, '');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?%?$/.test(cleaned)) return null;
    const value = Number.parseFloat(cleaned);
    return Number.isFinite(value) ? value : null;
};

/**
 * Parse the `data` block of an antv infographic body:
 *
 *     data
 *       title …
 *       items
 *         - label A
 *           value 70
 *
 * Accepts the body with or without the leading `infographic <layout>` line.
 * Returns null for anything unexpected (nested children, missing or
 * non-numeric values, no items) so the caller can fall back to antv.
 */
export const parseChartData = (syntax: string): LightChartData | null => {
    const lines = syntax.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    const start = lines.findIndex((l) => l.trim() === 'data');
    if (start < 0) return null;

    const dataIndent = indentOf(lines[start] as string);
    const out: LightChartData = {items: []};
    let inItems = false;
    let itemsIndent = -1;
    let current: Partial<LightChartItem> | null = null;
    let itemKeyIndent = -1;

    const flush = (): boolean => {
        if (current === null) return true;
        if (current.label === undefined || current.value === undefined) return false;
        out.items.push({label: current.label, value: current.value, ...(current.desc !== undefined ? {desc: current.desc} : {})});
        current = null;
        return true;
    };

    for (const line of lines.slice(start + 1)) {
        const indent = indentOf(line);
        if (indent <= dataIndent) break; // next top-level block (theme, design, …)
        const text = line.trim();

        if (inItems && indent > itemsIndent) {
            if (text.startsWith('- ')) {
                if (!flush()) return null;
                current = {};
                itemKeyIndent = indent + 2;
                const [key, value] = splitKey(text.slice(2));
                if (!assignItem(current, key, value)) return null;
                continue;
            }
            if (current === null || indent < itemKeyIndent) return null;
            if (indent > itemKeyIndent) return null; // nested children: not a flat chart
            const [key, value] = splitKey(text);
            if (!assignItem(current, key, value)) return null;
            continue;
        }

        if (inItems) {
            if (!flush()) return null;
            inItems = false;
        }

        const [key, value] = splitKey(text);
        if (key === 'items') {
            inItems = true;
            itemsIndent = indent;
        } else if (key === 'title' || key === 'desc' || key === 'xTitle' || key === 'yTitle') {
            if (value !== '') out[key] = value;
        }
        // other keys (e.g. unit, colors) are ignored
    }
    if (!flush()) return null;

    return out.items.length > 0 ? out : null;
};

/** Item keys: label, value, desc; icons and the like are ignored. Returns false on a bad value. */
const assignItem = (item: Partial<LightChartItem>, key: string, value: string): boolean => {
    if (key === 'label') item.label = value;
    else if (key === 'desc') item.desc = value;
    else if (key === 'value') {
        const n = parseNumber(value);
        if (n === null) return false;
        item.value = n;
    } else if (key === 'children') return false;
    return true;
};

