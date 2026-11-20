import {BarStrip, Sparkline} from 'jsngraph';
import {el} from './Dom.js';
import {formatNumber} from './I18n.js';
import type {LightChartData, LightChartKind} from './InfographicData.js';

/**
 * Infographic-Light renderer (plan P10 / S7): draws the simple antv chart
 * layouts with jsNGraph RectCharts. Loaded lazily by MarkdownPreview, and
 * only for notes that contain such a block; @antv/infographic is then not
 * loaded at all unless the note also has a complex layout.
 */

const PLOT_HEIGHT = 180;
const LINE_WIDTH = 640;
const LINE_HEIGHT = 200;

const caption = (data: LightChartData): HTMLElement | null => {
    if (data.title === undefined && data.desc === undefined) return null;
    return el('figcaption', {class: 'md-ig-caption'},
        ...(data.title !== undefined ? [el('strong', {class: 'md-ig-title', text: data.title})] : []),
        ...(data.desc !== undefined ? [el('span', {class: 'md-ig-desc', text: data.desc})] : [])
    );
};

const tooltip = (data: LightChartData, i: number): string => {
    const item = data.items[i];
    if (item === undefined) return '';
    return `${item.label}: ${formatNumber(item.value)}${item.desc !== undefined ? ` — ${item.desc}` : ''}`;
};

const axisTitle = (text: string | undefined, cls: string): Element[] =>
    text === undefined ? [] : [el('div', {class: `md-ig-axis ${cls}`, text})];

/** Value + label under each column; same grid as the bars above. */
const columnLabels = (data: LightChartData): HTMLElement => {
    const row = el('div', {class: 'md-ig-cols', style: {gridTemplateColumns: `repeat(${data.items.length}, minmax(0, 1fr))`}});
    for (const item of data.items) {
        row.appendChild(el('div', {class: 'md-ig-col', attrs: {title: item.desc ?? item.label}},
            el('span', {class: 'md-ig-value', text: formatNumber(item.value)}),
            el('span', {class: 'md-ig-label', text: item.label})
        ));
    }
    return row;
};

const renderColumns = (data: LightChartData): Element[] => {
    const n = data.items.length;
    const svg = new BarStrip({
        values: data.items.map((i) => i.value),
        width: n * 100,
        height: PLOT_HEIGHT,
        gap: 35, // of a 100-unit slot per column
        accent: 'var(--accent)',
        axisColor: 'var(--border)',
        titles: data.items.map((_, i) => tooltip(data, i))
    }).render();
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'md-ig-bars');
    return [...axisTitle(data.yTitle, 'md-ig-ytitle'), svg, columnLabels(data), ...axisTitle(data.xTitle, 'md-ig-xtitle')];
};

/** Horizontal ranking: label, bar track, value — text wraps, so HTML rows. */
const renderBars = (data: LightChartData): Element[] => {
    const max = Math.max(...data.items.map((i) => Math.abs(i.value)), 0);
    const list = el('div', {class: 'md-ig-hbars'});
    data.items.forEach((item, i) => {
        const pct = max > 0 ? (Math.abs(item.value) / max) * 100 : 0;
        list.appendChild(el('div', {class: 'md-ig-hbar', attrs: {title: tooltip(data, i)}},
            el('span', {class: 'md-ig-label', text: item.label}),
            el('span', {class: 'md-ig-track'}, el('span', {class: 'md-ig-fill', style: {width: `${pct}%`}})),
            el('span', {class: 'md-ig-value', text: formatNumber(item.value)})
        ));
    });
    return [...axisTitle(data.xTitle ?? data.yTitle, 'md-ig-ytitle'), list];
};

const renderLine = (data: LightChartData): Element[] => {
    const n = data.items.length;
    const pad = 4;
    const svg = new Sparkline({
        series: [{points: data.items.map((item, i) => ({x: i, y: item.value, title: tooltip(data, i)})), dots: true}],
        width: LINE_WIDTH,
        height: LINE_HEIGHT,
        yMin: Math.min(0, ...data.items.map((i) => i.value)),
        dot: 4,
        accent: 'var(--accent)',
        fluid: true
    }).render();
    svg.setAttribute('class', 'md-ig-line');
    // Labels under their points (same x maths as RectChartData.lines).
    const labels = el('div', {class: 'md-ig-points'});
    data.items.forEach((item, i) => {
        const x = n === 1 ? LINE_WIDTH / 2 : pad + (i / (n - 1)) * (LINE_WIDTH - 2 * pad);
        const align = i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'mid';
        labels.appendChild(el('div', {class: `md-ig-point md-ig-${align}`, style: {left: `${(x / LINE_WIDTH) * 100}%`}},
            el('span', {class: 'md-ig-value', text: formatNumber(item.value)}),
            el('span', {class: 'md-ig-label', text: item.label})
        ));
    });
    return [...axisTitle(data.yTitle, 'md-ig-ytitle'), svg, labels, ...axisTitle(data.xTitle, 'md-ig-xtitle')];
};

export const renderLightChart = (kind: LightChartKind, data: LightChartData): HTMLElement => {
    const body = kind === 'column' ? renderColumns(data) : kind === 'bar' ? renderBars(data) : renderLine(data);
    const cap = caption(data);
    return el('figure', {class: `md-ig-light md-ig-${kind}`}, ...(cap !== null ? [cap] : []), ...body);
};
